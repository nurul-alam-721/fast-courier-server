// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");
const serviceAccount = require("./firebase_admin_key.json");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ljb3mts.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let usersCollection, parcelsCollection, paymentCollection, ridersCollection;

// ------------------- MIDDLEWARE -------------------

// Verify Firebase token
const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).send({ message: "Unauthorized access" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized access" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (err) {
    return res.status(403).send({ message: "Forbidden access" });
  }
};

// Verify Admin
const verifyAdmin = async (req, res, next) => {
  const email = req.decoded.email;
  const user = await usersCollection.findOne({ email });
  if (!user || user.role !== "admin")
    return res.status(403).send({ message: "Forbidden" });
  next();
};

// Verify Rider
const verifyRider = async (req, res, next) => {
  const email = req.decoded.email;
  const user = await usersCollection.findOne({ email });
  if (!user || user.role !== "rider")
    return res.status(403).send({ message: "Forbidden" });
  next();
};

// ------------------- RUN SERVER -------------------
async function run() {
  try {
    await client.connect();
    const db = client.db("fastcourier");

    // Collections
    usersCollection = db.collection("users");
    parcelsCollection = db.collection("parcels");
    paymentCollection = db.collection("payments");
    ridersCollection = db.collection("riders");

    console.log("✅ Connected to MongoDB");

    // ---------------- ROOT ----------------
    app.get("/", (req, res) => res.send("🚀 FASTcourier server is running!"));

    // ---------------- USERS ----------------
    app.post("/users", async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).send({ error: "Email is required" });

      const existing = await usersCollection.findOne({ email });
      if (existing)
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });

      const result = await usersCollection.insertOne(req.body);
      res.status(201).send(result);
    });

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      res.send(await usersCollection.find().toArray());
    });

    app.get("/users/:email", verifyFBToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    });

    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const user = await usersCollection.findOne(
        { email: req.params.email },
        { projection: { role: 1 } }
      );
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json({ role: user.role || "user" });
    });

    // ---------------- RIDERS ----------------
    app.post("/riders", async (req, res) => {
      const { email, name, district } = req.body;
      if (!email || !name || !district)
        return res
          .status(400)
          .send({ message: "Email, name, district required" });

      const existing = await ridersCollection.findOne({ email });
      if (existing)
        return res.status(409).send({ message: "You have already applied." });

      const result = await ridersCollection.insertOne({
        ...req.body,
        status: "pending",
        createdAt: new Date(),
      });
      res.status(201).send(result);
    });

    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      res.send(await ridersCollection.find().toArray());
    });

    app.patch(
      "/riders/approve/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const rider = await ridersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!rider) return res.status(404).send({ error: "Rider not found" });

        await ridersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: "available", updatedAt: new Date() } }
        );

        await usersCollection.updateOne(
          { email: rider.email },
          { $set: { role: "rider" } }
        );

        res.send({ message: "Rider approved and role updated" });
      }
    );

    // GET /parcels/completed?riderEmail=<email>
    app.get(
      "/parcels/completed",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { riderEmail } = req.query;

        if (!riderEmail) {
          return res.status(400).json({ message: "Rider email is required" });
        }

        try {
          const parcels = await parcelsCollection
            .find({
              "assigned_rider.email": riderEmail,
              delivery_status: {
                $in: ["delivered", "service-center-delivered"],
              },
            })
            .sort({ assigned_at: -1 })
            .toArray();

          res.status(200).json(parcels);
        } catch (err) {
          console.error("Error fetching completed parcels:", err);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.post(
      "/rider/cash-out",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { parcelId, email, amount } = req.body;

        if (!amount || amount < 200) {
          return res
            .status(400)
            .json({ message: "Minimum cash-out amount is 200" });
        }

        try {
          if (parcelId) {
            // --- Single parcel cash-out ---
            const parcel = await parcelsCollection.findOne({
              _id: new ObjectId(parcelId),
            });
            if (!parcel)
              return res.status(404).json({ message: "Parcel not found" });
            if (parcel.earning_paid)
              return res
                .status(400)
                .json({ message: "Earning already cashed out" });

            const cashOutAmount = Math.min(amount, parcel.earning || 0);

            await parcelsCollection.updateOne(
              { _id: parcel._id },
              { $set: { earning_paid: true } }
            );

            await cashOutCollection.insertOne({
              rider_email: parcel.assigned_rider.email,
              parcel_id: parcel._id,
              amount: cashOutAmount,
              date: new Date(),
              status: "completed",
            });

            return res
              .status(200)
              .json({
                message: "Parcel earning cashed out",
                amount: cashOutAmount,
              });
          }

          if (email) {
            // --- Custom cash-out from total earnings ---
            const parcels = await parcelsCollection
              .find({
                "assigned_rider.email": email,
                delivery_status: {
                  $in: ["delivered", "service-center-delivered"],
                },
                earning_paid: { $ne: true },
              })
              .toArray();

            if (parcels.length === 0)
              return res
                .status(400)
                .json({ message: "No earnings to cash out" });

            const totalAvailable = parcels.reduce(
              (sum, p) => sum + (p.earning || 0),
              0
            );
            if (amount > totalAvailable)
              return res
                .status(400)
                .json({
                  message: "Requested amount exceeds available earnings",
                });

            // Distribute requested amount across parcels
            let remaining = amount;
            const cashOutRecords = [];

            for (const p of parcels) {
              if (remaining <= 0) break;

              const pay = Math.min(remaining, p.earning || 0);
              remaining -= pay;

              await parcelsCollection.updateOne(
                { _id: p._id },
                { $set: { earning_paid: true } }
              );

              cashOutRecords.push({
                rider_email: email,
                parcel_id: p._id,
                amount: pay,
                date: new Date(),
                status: "completed",
              });
            }

            await cashOutCollection.insertMany(cashOutRecords);

            return res
              .status(200)
              .json({ message: "Earnings cashed out", totalAmount: amount });
          }

          res.status(400).json({ message: "parcelId or email is required" });
        } catch (err) {
          console.error(err);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    // ---------------- PARCELS ----------------
    app.post("/parcels", verifyFBToken, async (req, res) => {
      const requiredFields = [
        "created_email",
        "sender_name",
        "sender_contact",
        "receiver_name",
        "receiver_contact",
        "delivery_address",
        "cost",
      ];
      if (req.body.type === "non-document") requiredFields.push("weight");

      for (const field of requiredFields) {
        if (!req.body[field])
          return res.status(400).send({ error: `${field} is required` });
      }

      const result = await parcelsCollection.insertOne({
        ...req.body,
        createdAt: new Date(),
        payment_status: "unpaid",
        delivery_status: "pending",
      });
      res.status(201).send(result);
    });

    // Admin assigns rider
    app.patch(
      "/parcels/assign-rider/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { assigned_rider, delivery_status } = req.body;
        const { id } = req.params;

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { assigned_rider, delivery_status, assigned_at: new Date() } }
        );

        if (result.matchedCount === 0)
          return res.status(404).json({ error: "Parcel not found" });
        res.json({ message: "Rider assigned successfully" });
      }
    );

    // Rider fetch assigned parcels
    app.get(
      "/parcels/assigned",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { riderEmail } = req.query;
        if (!riderEmail)
          return res.status(400).json({ message: "Rider email is required" });

        const parcels = await parcelsCollection
          .find({
            "assigned_rider.email": {
              $regex: `^${riderEmail}$`,
              $options: "i",
            },
            delivery_status: { $in: ["rider-assigned", "in-transit"] },
          })
          .sort({ assigned_at: -1 })
          .toArray();

        res.json(parcels);
      }
    );

    // Rider updates delivery status
    // Rider updates delivery status: in-transit → delivered
    app.patch(
      "/parcels/update-status/:id",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { newStatus } = req.body;
        const { id } = req.params;

        // Validate status
        if (!["in-transit", "delivered"].includes(newStatus)) {
          return res.status(400).json({ error: "Invalid status" });
        }

        try {
          const result = await parcelsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { delivery_status: newStatus, updatedAt: new Date() } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Parcel not found" });
          }

          res.json({ message: `Parcel marked as ${newStatus}` });
        } catch (err) {
          console.error("Error updating delivery status:", err);
          res.status(500).json({ error: "Server error" });
        }
      }
    );

    // ---------------- PAYMENTS ----------------
    app.post("/create-payment-intent", async (req, res) => {
      const { amountInCents, id: parcelId } = req.body;
      if (!amountInCents || !parcelId)
        return res
          .status(400)
          .send({ error: "Amount and parcel ID are required" });

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: "bdt",
        payment_method_types: ["card"],
        metadata: { parcelId },
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    });

    app.post("/payments", verifyFBToken, async (req, res) => {
      const { parcelId, amount, transactionId } = req.body;
      if (!parcelId || !amount || !transactionId)
        return res
          .status(400)
          .send({ error: "parcelId, amount, transactionId required" });

      await parcelsCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { payment_status: "paid", updatedAt: new Date() } }
      );
      const result = await paymentCollection.insertOne({
        parcelId,
        amount,
        transactionId,
        createdAt: new Date(),
      });
      res.status(201).json(result);
    });

    // ---------------- START SERVER ----------------
    app.listen(port, () => console.log(`✅ Server running on port ${port}`));
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}

run();
