require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decodedKey);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Firebase Admin
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// MongoDB
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ljb3mts.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let usersCollection,
  parcelsCollection,
  paymentCollection,
  ridersCollection,
  cashOutCollection,
  trackingsCollection;

// ---------------- AUTH ----------------
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    req.decoded = await admin.auth().verifyIdToken(token);
    next();
  } catch (err) {
    res
      .status(403)
      .json({ message: `Invalid or expired token: ${err.message}` });
  }
};

const verifyAdmin = async (req, res, next) => {
  try {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || user.role !== "admin")
      return res.status(403).json({ message: "Access denied" });
    next();
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

const verifyRider = async (req, res, next) => {
  try {
    const user = await usersCollection.findOne({ email: req.decoded.email });
    if (!user || user.role !== "rider")
      return res.status(403).json({ message: "Access denied" });
    next();
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ---------------- SERVER ----------------
async function run() {
  try {
    // await client.connect();
    const db = client.db("fastcourier");

    usersCollection = db.collection("users");
    parcelsCollection = db.collection("parcels");
    paymentCollection = db.collection("payments");
    ridersCollection = db.collection("riders");
    cashOutCollection = db.collection("cashouts");
    trackingsCollection = db.collection("trackings");

    console.log("✅ Connected to MongoDB");

    // ---------------- ROOT ----------------
    app.get("/", (req, res) => res.send("🚀 FASTcourier server is running!"));

    // ---------------- USERS ----------------
    app.post("/users", async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      const existing = await usersCollection.findOne({ email });
      if (existing)
        return res
          .status(200)
          .json({ message: "User exists", inserted: false });

      const result = await usersCollection.insertOne(req.body);
      res.status(201).json(result);
    });

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) =>
      res.json(await usersCollection.find().toArray())
    );
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
      res.json({ role: user?.role || "user" });
    });

    // ---------------- RIDERS ----------------
    app.post("/riders", async (req, res) => {
      const { email, name, district } = req.body;
      if (!email || !name || !district)
        return res
          .status(400)
          .json({ message: "Email, name, district required" });

      const existing = await ridersCollection.findOne({ email });
      if (existing) return res.status(409).json({ message: "Already applied" });

      const result = await ridersCollection.insertOne({
        ...req.body,
        status: "pending",
        createdAt: new Date(),
      });
      res.status(201).json(result);
    });

    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) =>
      res.json(await ridersCollection.find().toArray())
    );

    // GET all pending riders
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();

        res.json(pendingRiders);
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch pending riders" });
      }
    });

    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: { $in: ["available", "in-delivery"] } })
          .toArray();

        res.json(activeRiders);
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch active riders" });
      }
    });

    app.get(
      "/riders/available",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { district } = req.query;
        if (!district)
          return res.status(400).json({ error: "District required" });
        res.json(
          await ridersCollection
            .find({ district, status: "available" })
            .toArray()
        );
      }
    );

    app.patch(
      "/riders/approve/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const rider = await ridersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!rider) return res.status(404).json({ error: "Rider not found" });

        await ridersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: "available", updatedAt: new Date() } }
        );
        await usersCollection.updateOne(
          { email: rider.email },
          { $set: { role: "rider" } }
        );
        res.json({ message: "Rider approved and role updated" });
      }
    );

    app.patch(
      "/riders/update-status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;
        if (!ObjectId.isValid(id) || !status)
          return res.status(400).json({ message: "Invalid ID or status" });

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );
        if (result.matchedCount === 0)
          return res.status(404).json({ message: "Rider not found" });

        res.json({ message: "Rider status updated" });
      }
    );

    // ---------------- PARCELS ----------------
    app.get("/parcels", verifyFBToken, async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).json({ message: "Email required" });
      const parcels = await parcelsCollection
        .find({ created_email: email })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(parcels);
    });

    app.get(
      "/parcels/paid-pending",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const parcels = await parcelsCollection
          .find({ payment_status: "paid", delivery_status: "pending" })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(parcels);
      }
    );

    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ message: "Invalid parcel ID" });

      const parcel = await parcelsCollection.findOne({ _id: new ObjectId(id) });
      if (!parcel) return res.status(404).json({ message: "Parcel not found" });

      res.json(parcel);
    });

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
      for (const field of requiredFields)
        if (!req.body[field])
          return res.status(400).json({ error: `${field} is required` });

      const result = await parcelsCollection.insertOne({
        ...req.body,
        createdAt: new Date(),
        payment_status: "unpaid",
        delivery_status: "pending",
      });
      res.status(201).json(result);
    });

    app.patch(
      "/parcels/update-status/:id",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { id } = req.params;
        const { newStatus } = req.body;
        await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { delivery_status: newStatus, updatedAt: new Date() } }
        );
        res.json({ message: "Parcel status updated" });
      }
    );

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ message: "Invalid parcel ID" });

      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      if (result.deletedCount === 0)
        return res.status(404).json({ message: "Parcel not found" });

      res.json({ message: "Parcel deleted" });
    });

    app.patch(
      "/parcels/assign-rider/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { assigned_rider, delivery_status } = req.body;
        if (!ObjectId.isValid(id) || !assigned_rider || !delivery_status)
          return res.status(400).json({ message: "Invalid input" });

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { assigned_rider, delivery_status, assigned_at: new Date() } }
        );
        if (result.matchedCount === 0)
          return res.status(404).json({ message: "Parcel not found" });

        res.json({ message: "Rider assigned" });
      }
    );

    // ---------------- PAYMENTS ----------------
    app.post("/payments", verifyFBToken, async (req, res) => {
      const {
        parcelId,
        title,
        amount,
        transactionId,
        email,
        sender_name,
        paymentMethod,
        date,
      } = req.body;
      if (
        !parcelId ||
        !amount ||
        !transactionId ||
        !email ||
        !sender_name ||
        !title
      )
        return res.status(400).json({ message: "Missing required fields" });

      await parcelsCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { payment_status: "paid", updatedAt: new Date() } }
      );

      const paymentDoc = {
        parcelId,
        title,
        amount,
        transactionId,
        email,
        sender_name,
        paymentMethod: paymentMethod || [],
        date: date || new Date(),
        paid_at_string: new Date().toISOString(),
        createdAt: new Date(),
      };
      const result = await paymentCollection.insertOne(paymentDoc);
      res.status(201).json(result);
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).json({ message: "Email required" });

      const payments = await paymentCollection
        .find({ email })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(payments);
    });

    // ---------------- TRACKING ----------------
    app.post("/trackings/:parcelId", async (req, res) => {
      const { status, updatedBy, assigned_rider, details } = req.body;
      const { parcelId } = req.params;
      if (!status) return res.status(400).json({ message: "Status required" });

      const event = {
        status,
        updatedBy,
        timestamp: new Date(),
        ...(details && { details }),
        ...(status === "rider_assigned" &&
          assigned_rider && { assigned_rider }),
      };
      const tracking = await trackingsCollection.findOne({
        parcelId: new ObjectId(parcelId),
      });

      if (tracking)
        await trackingsCollection.updateOne(
          { parcelId: new ObjectId(parcelId) },
          { $push: { events: event } }
        );
      else
        await trackingsCollection.insertOne({
          parcelId: new ObjectId(parcelId),
          events: [event],
        });

      res.json({ message: "Tracking updated", event });
    });

    app.get("/trackings/:parcelId", async (req, res) => {
      const { parcelId } = req.params;
      const tracking = await trackingsCollection.findOne({
        parcelId: new ObjectId(parcelId),
      });
      if (!tracking)
        return res.status(404).json({ message: "No tracking found" });
      res.json(tracking);
    });

    // ---------------- DASHBOARDS ----------------
    app.get(
      "/admin/parcels/dashboard",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const statusCounts = await parcelsCollection
          .aggregate([
            { $group: { _id: "$delivery_status", count: { $sum: 1 } } },
            { $project: { _id: 0, delivery_status: "$_id", count: 1 } },
          ])
          .toArray();

        const earnings = await parcelsCollection
          .aggregate([
            { $group: { _id: null, totalEarning: { $sum: "$earning" } } },
          ])
          .toArray();
        const totalParcels = await parcelsCollection.countDocuments();

        res.json({
          statusCounts,
          totalParcels,
          totalEarnings: earnings[0]?.totalEarning || 0,
        });
      }
    );

    app.get(
      "/rider/parcels/dashboard",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.decoded.email;
        const assignedParcels = await parcelsCollection
          .find({ "assigned_rider.email": riderEmail })
          .toArray();
        const statusCounts = await parcelsCollection
          .aggregate([
            { $match: { "assigned_rider.email": riderEmail } },
            { $group: { _id: "$delivery_status", count: { $sum: 1 } } },
            { $project: { _id: 0, delivery_status: "$_id", count: 1 } },
          ])
          .toArray();

        res.json({ assignedParcels, statusCounts });
      }
    );

    app.get("/user/parcels/dashboard", verifyFBToken, async (req, res) => {
      const userEmail = req.decoded.email;
      const myParcels = await parcelsCollection
        .find({ created_email: userEmail })
        .sort({ createdAt: -1 })
        .toArray();

      const statusCounts = await parcelsCollection
        .aggregate([
          { $match: { created_email: userEmail } },
          { $group: { _id: "$delivery_status", count: { $sum: 1 } } },
          { $project: { _id: 0, delivery_status: "$_id", count: 1 } },
        ])
        .toArray();

      const totalPaidAgg = await parcelsCollection
        .aggregate([
          { $match: { created_email: userEmail, payment_status: "paid" } },
          { $group: { _id: null, totalPaid: { $sum: "$paid_amount" } } },
        ])
        .toArray();

      const totalEarningsAgg = await parcelsCollection
        .aggregate([
          { $match: { created_email: userEmail } },
          { $group: { _id: null, totalEarning: { $sum: "$earning" } } },
        ])
        .toArray();

      res.json({
        myParcels,
        statusCounts,
        totalPaid: totalPaidAgg[0]?.totalPaid || 0,
        totalParcels: myParcels.length,
        totalEarning: totalEarningsAgg[0]?.totalEarning || 0,
      });
    });

    // ---------------- RIDER CASH-OUT ----------------
    app.get(
      "/rider/cash-out/history/:email",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { email } = req.params;
        if (email !== req.decoded.email)
          return res.status(403).json({ message: "Forbidden" });

        const history = await cashOutCollection
          .find({ email })
          .sort({ date: -1 })
          .toArray();
        res.json(history);
      }
    );

    app.get(
      "/rider/cash-out/total/:email",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { email } = req.params;
        if (email !== req.decoded.email)
          return res.status(403).json({ message: "Forbidden" });

        const result = await cashOutCollection
          .aggregate([
            { $match: { email, status: "completed" } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray();

        res.json({ total: result[0]?.total || 0 });
      }
    );

    // ---------------- START SERVER ----------------
    app.listen(port, () => console.log(`✅ Server running on port ${port}`));
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}

run();
