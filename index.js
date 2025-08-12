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

// Verify Firebase Token
const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).send({ error: "Unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next();
  } catch {
    return res.status(403).send({ error: "Forbidden: Invalid token" });
  }
};

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ljb3mts.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
  try {
    await client.connect();
    const db = client.db("fastcourier");

    // Collections
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const trackingCollection = db.collection("trackings");
    const ridersCollection = db.collection("riders");

    console.log("✅ Connected to MongoDB");

    // Verify Admin Middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Unauthorized access" });
      }
      next();
    };

    // Root
    app.get("/", (req, res) => {
      res.send("🚀 FASTcourier server is running!");
    });

    // ---------------- USERS ----------------
    app.post("/users", async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).send({ error: "Email is required" });

      const existing = await usersCollection.findOne({ email });
      if (existing) {
        return res.status(200).send({ message: "User already exists", inserted: false });
      }
      const result = await usersCollection.insertOne(req.body);
      res.status(201).send(result);
    });

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      res.send(await usersCollection.find().toArray());
    });

    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email query is required" });
      const regex = new RegExp(email, "i");
      res.send(await usersCollection.find({ email: { $regex: regex } }).toArray());
    });

    app.patch("/users/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const { role } = req.body;
      if (!["admin", "user"].includes(role)) {
        return res.status(400).send({ error: "Invalid role" });
      }
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role } }
      );
      res.send(result);
    });

    app.get("/users/role", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email is required" });
      const user = await usersCollection.findOne({ email }, { projection: { role: 1 } });
      if (!user) return res.status(404).send({ message: "User not found" });
      res.send({ role: user.role || "user" });
    });

    // ---------------- RIDERS ----------------
    app.post("/riders", async (req, res) => {
      const { email, name, district } = req.body;
      if (!email || !name || !district) {
        return res.status(400).send({ message: "Email, name, and district are required" });
      }
      const existing = await ridersCollection.findOne({ email });
      if (existing) {
        return res.status(409).send({ message: "You have already applied." });
      }
      const result = await ridersCollection.insertOne({ ...req.body, status: "pending" });
      res.status(201).send(result);
    });

    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      res.send(await ridersCollection.find({ status: "pending" }).toArray());
    });

    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      res.send(await ridersCollection.find({ status: "active" }).toArray());
    });

    app.patch("/riders/approve/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const rider = await ridersCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!rider) return res.status(404).send({ error: "Rider not found" });

      await ridersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: "active", updatedAt: new Date() } }
      );
      await usersCollection.updateOne(
        { email: rider.email },
        { $set: { role: "rider" } }
      );
      res.send({ message: "Rider approved and user role updated" });
    });

    app.patch("/riders/pending/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: "pending", updatedAt: new Date() } }
      );
      res.send(result);
    });

    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;
      if (!district) return res.status(400).send({ message: "District is required" });
      res.send(await ridersCollection.find({ district, status: "active", work_status: "available" }).toArray());
    });

    app.delete("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      res.send(await ridersCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
    });

    // ---------------- PARCELS ----------------
    app.get("/parcels", verifyFBToken, async (req, res) => {
      const query = {};
      if (req.query.email) query.created_email = req.query.email;
      if (req.query.payment_status) query.payment_status = req.query.payment_status;
      if (req.query.delivery_status) query.delivery_status = req.query.delivery_status;
      res.send(await parcelsCollection.find(query).sort({ createdAt: -1 }).toArray());
    });

    app.get("/parcels/:id", async (req, res) => {
      const parcel = await parcelsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!parcel) return res.status(404).send({ error: "Parcel not found" });
      res.send(parcel);
    });

    app.post("/parcels", verifyFBToken, async (req, res) => {
      const required = ["created_email", "sender_name", "sender_phone", "recipient_name", "recipient_phone", "delivery_address", "weight", "price"];
      for (const field of required) {
        if (!req.body[field]) return res.status(400).send({ error: `${field} is required` });
      }
      const result = await parcelsCollection.insertOne({
        ...req.body,
        createdAt: new Date(),
        payment_status: "unpaid",
        delivery_status: "pending"
      });
      res.status(201).send(result);
    });

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const result = await parcelsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      if (result.deletedCount === 0) return res.status(404).send({ message: "Parcel not found" });
      res.send({ message: "Parcel deleted" });
    });

    app.patch("/parcels/assign-rider/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const { assigned_rider } = req.body;
      const rider = await ridersCollection.findOne({ email: assigned_rider.email, status: "active", work_status: "available" });
      if (!rider) return res.status(404).send({ error: "Available rider not found" });

      await parcelsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { assigned_rider, delivery_status: "in-transit" } }
      );
      await ridersCollection.updateOne({ email: assigned_rider.email }, { $set: { work_status: "in-delivery" } });
      res.send({ message: "Rider assigned" });
    });

    // ---------------- PAYMENTS ----------------
    app.post("/create-payment-intent", async (req, res) => {
      const { amountInCents, currency = "usd", metadata = {} } = req.body;
      if (!amountInCents || amountInCents <= 0) return res.status(400).send({ error: "Invalid amount" });
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency,
        automatic_payment_methods: { enabled: true },
        metadata,
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    app.post("/payments", verifyFBToken, async (req, res) => {
      const { parcelId, transactionId, amount } = req.body;
      if (!parcelId || !transactionId || amount <= 0) return res.status(400).send({ error: "Invalid payment data" });

      await paymentCollection.insertOne({ ...req.body, email: req.decoded.email, createdAt: new Date() });
      await parcelsCollection.updateOne({ _id: new ObjectId(parcelId) }, { $set: { payment_status: "paid", transactionId } });
      res.send({ message: "Payment recorded" });
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const query = req.query.email ? { email: req.query.email } : {};
      res.send(await paymentCollection.find(query).sort({ createdAt: -1 }).toArray());
    });

    // ---------------- TRACKING ----------------
    app.post("/trackings", verifyFBToken, async (req, res) => {
      const { parcelId } = req.body;
      if (!parcelId) return res.status(400).send({ error: "Missing parcelId" });
      const parcel = await parcelsCollection.findOne({ _id: new ObjectId(parcelId) });
      if (!parcel) return res.status(404).send({ error: "Parcel not found" });

      const tracking = {
        parcelId,
        status: "Parcel Booked",
        location: "Sender's Location",
        updatedAt: new Date(),
        history: [{ status: "Parcel Booked", location: "Sender's Location", timestamp: new Date() }],
      };
      const result = await trackingCollection.insertOne(tracking);
      res.send(result);
    });

    // ---------------- SERVER START ----------------
    app.listen(port, () => console.log(`✅ Server running on port ${port}`));

  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}

run();
