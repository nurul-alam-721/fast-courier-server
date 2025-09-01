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

let usersCollection,
  parcelsCollection,
  paymentCollection,
  ridersCollection,
  cashOutCollection;

// ------------------- MIDDLEWARE -------------------
const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res
      .status(401)
      .json({ message: "No authorization header provided" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch (err) {
    return res
      .status(403)
      .json({ message: `Invalid or expired token: ${err.message}` });
  }
};

const verifyAdmin = async (req, res, next) => {
  const email = req.decoded.email;
  try {
    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(403).json({ message: `User not found: ${email}` });
    }
    if (user.role !== "admin") {
      return res
        .status(403)
        .json({ message: `User is not an admin: ${email}` });
    }
    next();
  } catch (err) {
    return res.status(500).json({
      message: "Server error during admin verification",
      error: err.message,
    });
  }
};

// Verify Rider
const verifyRider = async (req, res, next) => {
  const email = req.decoded.email; // comes from Firebase token
  try {
    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(403).json({ message: `User not found: ${email}` });
    }
    if (user.role !== "rider") {
      return res.status(403).json({ message: `User is not a rider: ${email}` });
    }
    next();
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
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
    cashOutCollection = db.collection("cashouts");

    console.log("✅ Connected to MongoDB");

    // ---------------- ROOT ----------------
    app.get("/", (req, res) => res.send("🚀 FASTcourier server is running!"));

    // Test endpoint
    app.get("/test-auth", verifyFBToken, (req, res) => {
      res.json({
        message: "Authentication successful",
        user: req.decoded,
      });
    });

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


     app.get(
      "/parcels/assigned",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const riderEmail = req.decoded.email;
          console.log("Rider email from token:", riderEmail); 

          const parcels = await parcelsCollection
            .find({
              "assigned_rider.email": riderEmail,
              delivery_status: { $in: ["rider-assigned", "in-transit"] },
            })
            .sort({ assigned_at: -1 })
            .toArray();

          console.log("Found parcels:", parcels.length);
          res.json(parcels);
        } catch (error) {
          console.error("Error fetching assigned parcels:", error);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

   app.get(
  "/parcels/completed",
  verifyFBToken,
  verifyRider,
  async (req, res) => {
    try {
      // Use email from token
      const riderEmail = req.decoded.email;
      const completedParcels = await parcelsCollection
        .find({ 
          "assigned_rider.email": riderEmail,
          delivery_status: "delivered" 
        })
        .sort({ updatedAt: -1 })
        .toArray();
      res.status(200).json(completedParcels);
    } catch (error) {
      console.error("Failed to fetch completed parcels:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
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

    // GET available riders by district
    app.get(
      "/riders/available",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { district } = req.query;
          if (!district) {
            return res
              .status(400)
              .json({ error: "District parameter is required" });
          }
          const riders = await ridersCollection
            .find({
              district: district,
              status: "available",
            })
            .toArray();
          res.status(200).json(riders);
        } catch (err) {
          res.status(500).json({ error: "Server error" });
        }
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

    // PATCH update rider status
    app.patch(
      "/riders/update-status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;
          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid rider ID" });
          }
          if (!status) {
            return res.status(400).json({ error: "Status is required" });
          }
          const result = await ridersCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                status: status,
                updatedAt: new Date(),
              },
            }
          );
          if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Rider not found" });
          }
          res
            .status(200)
            .json({ message: "Rider status updated successfully" });
        } catch (err) {
          console.error("Error updating rider status:", err);
          res.status(500).json({ error: "Server error" });
        }
      }
    );

    // ---------------- PARCELS ----------------
    // FIXED: Reordered routes to prevent conflicts
    app.get("/parcels", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).json({ message: "Email is required" });
      const parcels = await parcelsCollection
        .find({ created_email: email })
        .sort({ createdAt: -1 })
        .toArray();
      res.status(200).json(parcels);
    });

    // MOVED HERE: Specific route before parameterized route
    app.get(
      "/parcels/paid-pending",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          console.log(
            "Processing GET /parcels/paid-pending for user:",
            req.decoded.email
          );
          const parcels = await parcelsCollection
            .find({ payment_status: "paid", delivery_status: "pending" })
            .sort({ createdAt: -1 })
            .toArray();
          console.log(
            "Fetched parcels:",
            parcels.length,
            "Documents:",
            parcels
          );
          res.status(200).json(parcels);
        } catch (err) {
          console.error("Error fetching paid-pending parcels:", err.message);
          res.status(500).json({
            message: "Server error fetching parcels",
            error: err.message,
          });
        }
      }
    );

    // NOW AFTER: Parameterized route
    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      // FIXED: Added explicit ObjectId validation
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid parcel ID format" });
      }
      try {
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel)
          return res.status(404).json({ message: "Parcel not found" });
        res.status(200).json(parcel);
      } catch (err) {
        console.error("Error fetching parcel:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

   
    app.patch(
      "/parcels/update-status/:id",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { id } = req.params;
        const { newStatus } = req.body;

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { delivery_status: newStatus, updatedAt: new Date() } }
        );

        res.json(result);
      }
    );

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const parcelId = req.params.id;
      try {
        // FIXED: Added ObjectId validation
        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).json({ message: "Invalid parcel ID format" });
        }
        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(parcelId),
        });
        if (result.deletedCount === 1)
          res
            .status(200)
            .json({ success: true, message: "Parcel deleted successfully" });
        else
          res.status(404).json({ success: false, message: "Parcel not found" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
      }
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

    // Get active riders
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      const riders = await ridersCollection
        .find({ status: "available" })
        .toArray();
      res.json(riders);
    });

    // Get pending riders
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      const riders = await ridersCollection
        .find({ status: "pending" })
        .toArray();
      res.json(riders);
    });

    // Assign rider to parcel
    app.patch(
      "/parcels/assign-rider/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        if (!id || !ObjectId.isValid(id)) {
          console.error("Invalid parcel ID received:", id);
          return res.status(400).json({ message: "Invalid parcel ID format" });
        }
        const { assigned_rider, delivery_status } = req.body;
        if (!assigned_rider || !delivery_status) {
          console.error("Missing required fields:", {
            assigned_rider,
            delivery_status,
          });
          return res.status(400).json({
            message: "Assigned rider and delivery status are required",
          });
        }
        try {
          const parcel = await parcelsCollection.findOne({
            _id: new ObjectId(id),
          });
          console.log("Parcel found:", parcel);
          if (!parcel) {
            return res.status(404).json({ message: "Parcel not found" });
          }
          const result = await parcelsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                assigned_rider,
                delivery_status,
                assigned_at: new Date(),
              },
            }
          );
          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Parcel not found" });
          }
          console.log("Rider assigned successfully for parcel ID:", id);
          res.status(200).json({ message: "Rider assigned successfully" });
        } catch (err) {
          console.error("Error assigning rider:", err.message);
          res.status(500).json({ message: "Server error", error: err.message });
        }
      }
    );

    // ---------------- PAYMENT ----------------
    app.post("/create-payment-intent", async (req, res) => {
      const { amountInCents, id: parcelId } = req.body;
      if (!amountInCents || !parcelId)
        return res.status(400).send({ error: "Amount and parcel ID required" });
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: "bdt",
        payment_method_types: ["card"],
        metadata: { parcelId },
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    });

    // Save payment info
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
      // Validation
      if (
        !parcelId ||
        !amount ||
        !transactionId ||
        !email ||
        !sender_name ||
        !title
      ) {
        return res.status(400).json({
          error:
            "parcelId, title, amount, transactionId, email, and sender_name are required",
        });
      }
      try {
        // Update parcel as paid
        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid", updatedAt: new Date() } }
        );
        // Insert payment record
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
      } catch (err) {
        console.error("Error saving payment:", err);
        res.status(500).json({ error: "Server error" });
      }
    });

    // GET /payments?email=<user email>
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).json({ message: "Email is required" });
      try {
        const payments = await paymentCollection
          .find({ email })
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).json(payments);
      } catch (err) {
        console.error("Error fetching payments:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ---------------- RIDER CASH OUT ----------------
    app.post(
      "/rider/cash-out",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { parcelId, riderEmail, amount } = req.body;
        if (!amount || amount < 200)
          return res
            .status(400)
            .json({ message: "Minimum cash-out amount is 200" });
        try {
          if (parcelId) {
            const parcel = await parcelsCollection.findOne({
              _id: new ObjectId(parcelId),
            });
            if (!parcel)
              return res.status(404).json({ message: "Parcel not found" });
            const cost = Number(parcel.cost) || 0;
            const totalEarning =
              parcel.sender_region === parcel.receiver_region
                ? cost * 0.1
                : cost * 0.2;
            const alreadyPaid = parcel.paid_amount || 0;
            const remaining = totalEarning - alreadyPaid;
            if (remaining <= 0)
              return res
                .status(400)
                .json({ message: "Parcel already fully cashed out" });
            if (amount > remaining)
              return res
                .status(400)
                .json({ message: "Amount exceeds remaining parcel earning" });
            await parcelsCollection.updateOne(
              { _id: parcel._id },
              {
                $inc: { paid_amount: amount },
                $set: {
                  earning: totalEarning,
                  earning_paid: alreadyPaid + amount >= totalEarning,
                },
              }
            );
            await cashOutCollection.insertOne({
              riderEmail,
              parcelId: parcel._id,
              parcelTitle: parcel.title,
              amount,
              date: new Date(),
              status: "completed",
            });
            return res
              .status(200)
              .json({ message: "Parcel earning cashed out", amount });
          }
          if (riderEmail) {
            const parcels = await parcelsCollection
              .find({
                "assigned_rider.email": riderEmail,
                delivery_status: {
                  $in: ["delivered", "service-center-delivered"],
                },
              })
              .toArray();
            if (!parcels.length)
              return res
                .status(400)
                .json({ message: "No earnings to cash out" });
            const totalAvailable = parcels.reduce((sum, p) => {
              const cost = Number(p.cost) || 0;
              const total =
                p.sender_region === p.receiver_region ? cost * 0.1 : cost * 0.2;
              const paid = p.paid_amount || 0;
              return sum + (total - paid);
            }, 0);
            if (amount > totalAvailable)
              return res
                .status(400)
                .json({ message: "Amount exceeds total available earnings" });
            let remainingAmount = amount;
            const cashOutRecords = [];
            for (const p of parcels) {
              if (remainingAmount <= 0) break;
              const cost = Number(p.cost) || 0;
              const total =
                p.sender_region === p.receiver_region ? cost * 0.1 : cost * 0.2;
              const paid = p.paid_amount || 0;
              const available = total - paid;
              if (available > 0) {
                const pay = Math.min(remainingAmount, available);
                remainingAmount -= pay;
                await parcelsCollection.updateOne(
                  { _id: p._id },
                  {
                    $inc: { paid_amount: pay },
                    $set: { earning: total, earning_paid: paid + pay >= total },
                  }
                );
                cashOutRecords.push({
                  riderEmail,
                  parcelId: p._id,
                  parcelTitle: p.title,
                  amount: pay,
                  date: new Date(),
                  status: "completed",
                });
              }
            }
            await cashOutCollection.insertMany(cashOutRecords);
            return res
              .status(200)
              .json({ message: "Earnings cashed out", totalAmount: amount });
          }
          res
            .status(400)
            .json({ message: "parcelId or riderEmail is required" });
        } catch (err) {
          console.error(err);
          res.status(500).json({ message: "Server error" });
        }
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
