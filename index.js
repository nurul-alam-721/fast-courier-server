const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ljb3mts.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Collections (accessible globally)

    const db = client.db("fastcourier");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const trackingCollection = db.collection("trackings");


// Root route
app.get("/", (req, res) => {
  res.send("🚀 FASTcourier server is running!");
});

// ✅ USERS API
app.post("/users", async (req, res) => {
  try {
    const email = req.body.email;
    console.log('The email of user is:', {email})

    const userExists = await usersCollection.findOne({ email });
    if (userExists) {

      return res.status(200).send({ message: "User already exists", inserted: false });
  
    }

    const user = req.body;
    const result = await usersCollection.insertOne(user);
    res.status(201).send(result);
  } catch (err) {
    console.log('Errror got')
    res.status(500).send({ error: "Failed to insert user", details: err.message });
  }
});

// PARCEL ROUTES
app.get("/parcels", async (req, res) => {
  try {
    const { email } = req.query;
    const query = email ? { created_email: email } : {};
    const parcels = await parcelsCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(parcels);
  } catch (err) {
    res.status(500).send({ message: "Failed to fetch parcels", error: err.message });
  }
});

app.get("/parcels/:id", async (req, res) => {
  try {
    const parcel = await parcelsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.send(parcel);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/parcels", async (req, res) => {
  try {
    const parcel = req.body;
    const result = await parcelsCollection.insertOne(parcel);
    res.status(201).json({ success: true, insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.delete("/parcels/:id", async (req, res) => {
  try {
    const result = await parcelsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Parcel not found." });
    }
    res.json({ message: "Parcel deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PAYMENT ROUTES
app.post("/create-payment-intent", async (req, res) => {
  const { amountInCents, currency = "usd", metadata = {} } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata,
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/payments", async (req, res) => {
  try {
    const payment = req.body;
    if (!payment.parcelId) {
      return res.status(400).json({ error: "Missing parcelId in payment data" });
    }

    const historyResult = await paymentCollection.insertOne({
      ...payment,
      createdAt: new Date(),
    });

    const parcelUpdate = await parcelsCollection.updateOne(
      { _id: new ObjectId(payment.parcelId) },
      {
        $set: {
          payment_status: "paid",
          transactionId: payment.transactionId || "",
        },
      }
    );

    res.send({
      insertedId: historyResult.insertedId,
      modifiedCount: parcelUpdate.modifiedCount,
      message: "✅ Payment recorded and parcel updated.",
    });
  } catch (error) {
    res.status(500).send({ error: "Failed to record payment." });
  }
});

app.get("/payments", async (req, res) => {
  try {
    const query = req.query.email ? { email: req.query.email } : {};
    const payments = await paymentCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.send(payments);
  } catch (err) {
    res.status(500).send({ error: "Failed to load payment history" });
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
      history: [
        {
          status: "Parcel Booked",
          location: "Sender's Location",
          timestamp: new Date(),
        },
      ],
    };
    const result = await trackingCollection.insertOne(tracking);
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: "Failed to insert tracking" });
  }
});

// Start server
app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
