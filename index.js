const express = require("express");
const app = express();
const cors = require("cors");
const dotenv = require("dotenv");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ljb3mts.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// MongoDB client config
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let parcelsCollection;

// Connect to MongoDB
async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB");

    const db = client.db("fastcourier");
    parcelsCollection = db.collection("parcels");
    paymentCollection = db.collection("payments");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}
run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
  res.send("🚀 FASTcourier server is running!");
});

// Get all parcels (optionally by email)
app.get("/parcels", async (req, res) => {
  if (!parcelsCollection) {
    return res.status(503).send({ message: "Database not connected yet." });
  }
  try {
    const { email } = req.query;
    const query = email ? { created_email: email } : {};
    const options = { sort: { createdAt: -1 } };
    const parcels = await parcelsCollection.find(query, options).toArray();
    res.status(200).send(parcels);
  } catch (err) {
    console.error("❌ Failed to fetch parcels:", err);
    res
      .status(500)
      .send({ message: "Failed to fetch parcels", error: err.message });
  }
});

// Get parcel by ID
app.get("/parcels/:id", async (req, res) => {
  try {
    const objectId = new ObjectId(req.params.id);
    const parcel = await parcelsCollection.findOne({ _id: objectId });
    res.send(parcel);
  } catch (err) {
    console.error("❌ Server error during parcel fetch:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete parcel by ID
app.delete("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const result = await parcelsCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Parcel not found." });
    }

    res.json({ message: "Parcel deleted successfully." });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

app.post("/create-payment-intent", async (req, res) => {
  const amountInCents = req.body.amountInCents;
  try {
    // Extract payment information from the request
    const { currency = "usd", metadata = {} } = req.body;

    // Create a PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: metadata,
    });

    // Send the client secret to the client
    res.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// payments
app.post("/payments", async (req, res) => {
  try {
    const payment = req.body;

    // 1. Insert payment into paymentHistory collection
    const historyResult = await db
      .paymentCollection("payments")
      .insertOne(payment);

    // 2. Update parcel payment_status to "paid"
    const parcelUpdate = await db.paymentCollection("parcels").updateOne(
      { _id: new ObjectId(payment.parcelId) },
      {
        $set: {
          payment_status: "paid",
        },
      }
    );

    res.send({
      insertedId: historyResult.insertedId,
      modifiedCount: parcelUpdate.modifiedCount,
      message: "Payment recorded and parcel updated.",
    });
  } catch (error) {
    console.error("Payment saving failed:", error);
    res.status(500).send({ error: "Failed to record payment." });
  }
});

// GET /payments?email=user@example.com
app.get("/payments", async (req, res) => {
  const email = req.query.email;

  const query = email ? { email } : {};
  const payments = await db
    .paymentCollection("payments")
    .find(query)
    .sort({ date: -1 })
    .toArray();

  res.send(payments);
});

// Start server
app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
