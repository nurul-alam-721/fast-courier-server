require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ljb3mts.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// Collections
let parcelsCollection;
let paymentCollection;
let usersCollection;
let trackingCollection;
let ridersCollection;

// Connect and initialize collections
async function run() {
  try {
    await client.connect();
    const db = client.db("fastcourier");
    parcelsCollection = db.collection("parcels");
    paymentCollection = db.collection("payments");
    usersCollection = db.collection("users");
    trackingCollection = db.collection("trackings");
    ridersCollection = db.collection("riders");
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}
run();

// Confirm server running
app.get("/", (req, res) => {
  res.send("🚀 FASTcourier server is running!");
});

// USERS API
app.post("/users", async (req, res) => {
  try {
    const { email } = req.body;
    console.log("Registering user:", email);
    const userExists = await usersCollection.findOne({ email });
    if (userExists) {
      return res.status(200).send({ message: "User already exists", inserted: false });
    }
    const result = await usersCollection.insertOne(req.body);
    res.status(201).send(result);
  } catch (err) {
    res.status(500).send({ error: "Failed to insert user", details: err.message });
  }
});

// RIDE APPLICATION: Apply to be a rider
app.post("/riders", async (req, res) => {
  try {
    const rider = { ...req.body, status: "pending" };  // Set default status to pending

    if (!rider.email) {
      return res.status(400).send({ message: "Email is required" });
    }

    // Prevent duplicate applications
    const existing = await ridersCollection.findOne({ email: rider.email });
    if (existing) {
      return res.status(409).send({
        message: "You have already applied.",
        alreadyApplied: true,
      });
    }

    const result = await ridersCollection.insertOne(rider);
    res.status(201).send({
      message: "Rider application submitted",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("❌ Rider insert error:", error.message);
    res.status(500).send({ message: "Failed to apply", error: error.message });
  }
});

// Get pending riders
app.get("/riders/pending", async (req, res) => {
  try {
    const pendingRiders = await ridersCollection.find({ status: "pending" }).toArray();
    res.send(pendingRiders);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch pending riders", error: err.message });
  }
});

//get approved riders
app.get("/riders/approved", async (req, res) => {
  const approved = await ridersCollection.find({ status: "approved" }).toArray();
  res.send(approved);
});


// Approve rider
app.patch("/riders/approve/:id", async (req, res) => {
  try {
    const result = await ridersCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: "approved" } }
    );
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.patch("/riders/pending/:id", async (req, res) => {
  const id = req.params.id;
  const result = await ridersCollection.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        status: "pending",
        updatedAt: new Date(),
      },
    }
  );
  res.send(result);
});


// Delete rider
app.delete("/riders/:id", async (req, res) => {
  try {
    const result = await ridersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// PARCEL ROUTES
app.get("/parcels", async (req, res) => {
  try {
    const query = req.query.email ? { created_email: req.query.email } : {};
    const parcels = await parcelsCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(parcels);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.get("/parcels/:id", async (req, res) => {
  try {
    const parcel = await parcelsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.send(parcel);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.post("/parcels", async (req, res) => {
  try {
    const parcel = { ...req.body, createdAt: new Date(), payment_status: "unpaid" };
    const result = await parcelsCollection.insertOne(parcel);
    res.status(201).send(result);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.delete("/parcels/:id", async (req, res) => {
  try {
    const result = await parcelsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).send({ message: "Parcel not found" });
    res.send({ message: "Parcel deleted" });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// STRIPE PAYMENTS
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amountInCents, currency = "usd", metadata = {} } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata,
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.post("/payments", async (req, res) => {
  try {
    const payment = req.body;
    if (!payment.parcelId) return res.status(400).send({ error: "Missing parcelId" });
    const historyResult = await paymentCollection.insertOne({ ...payment, createdAt: new Date() });
    const parcelUpdate = await parcelsCollection.updateOne(
      { _id: new ObjectId(payment.parcelId) },
      { $set: { payment_status: "paid", transactionId: payment.transactionId || "" } }
    );
    res.send({ insertedId: historyResult.insertedId, modifiedCount: parcelUpdate.modifiedCount });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.get("/payments", async (req, res) => {
  try {
    const query = req.query.email ? { email: req.query.email } : {};
    const payments = await paymentCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(payments);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// TRACKING ROUTES
app.post("/trackings", async (req, res) => {
  try {
    const { parcelId } = req.body;
    const tracking = {
      parcelId,
      status: "Parcel Booked",
      location: "Sender's Location",
      updatedAt: new Date(),
      history: [{
        status: "Parcel Booked",
        location: "Sender's Location",
        timestamp: new Date(),
      }],
    };
    const result = await trackingCollection.insertOne(tracking);
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
