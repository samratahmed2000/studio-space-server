import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const PORT = process.env.PORT || 8000;

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

app.use(cors());
app.use(express.json());

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("studioSpace");
const categoryCollection = db.collection("categories");
const studioCollection = db.collection("studios");
const bookingCollection = db.collection("bookings");
const savedStudioCollection = db.collection("wishlist");

// Middleware
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized!" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  const JWKS = createRemoteJWKSet(
    new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
  );

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Invalid or Expired Token." });
  }
};

app.get("/categories", async (req, res) => {
  const result = await categoryCollection.find().toArray();
  res.send(result);
});

app.post("/add-studio", verifyToken, async (req, res) => {
  const data = req.body;
  const result = await studioCollection.insertOne(data);
  res.send(result);
});

app.get("/studios", async (req, res) => {
  const result = await studioCollection.find().toArray();
  res.send(result);
});

app.get("/featured-studios", async (req, res) => {
  const result = await studioCollection
    .find()
    .sort({ hourlyRate: -1 })
    .limit(6)
    .toArray();
  res.send(result);
});

app.get("/studios/:id", async (req, res) => {
  const { id } = req.params;
  const result = await studioCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

app.patch("/studios/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  const result = await studioCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: data },
  );
  res.json(result);
});

app.delete("/studios/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const result = await studioCollection.deleteOne({ _id: new ObjectId(id) });
  res.json(result);
});

app.post("/booking", verifyToken, async (req, res) => {
  const data = req.body;
  const booking = await bookingCollection.findOne({
    studioId: data.studioId,
    bookingDate: data.bookingDate,
    status: { $ne: "cancelled" },
    $expr: {
      $and: [
        { $lt: ["$startTime", data.endTime] },
        { $gt: ["$endTime", data.startTime] },
      ],
    },
  });

  if (booking) {
    return res.status(409).send({
      message: "This studio is already booked for the selected time.",
    });
  }

  const result = await bookingCollection.insertOne(data);
  res.send(result);
});

app.get("/my-bookings/:email", verifyToken, async (req, res) => {
  const { email } = req.params;
  const result = await bookingCollection.find({ email: email }).toArray();
  res.send(result);
});

app.patch("/my-bookings/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  const result = await bookingCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: data },
  );
  res.json(result);
});

app.delete("/my-bookings/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const result = await bookingCollection.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
});

app.post("/studio-wishlist", verifyToken, async (req, res) => {
  const email = req.user?.email;
  const studioId = String(req.body?.studioId ?? "");

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (!studioId || !ObjectId.isValid(studioId)) {
    return res.status(400).send({ message: "A valid studioId is required." });
  }

  const studio = await studioCollection.findOne({
    _id: new ObjectId(studioId),
  });

  if (!studio) {
    return res.status(404).send({ message: "Studio not found." });
  }

  const existing = await savedStudioCollection.findOne({ email, studioId });

  if (existing) {
    return res.send({ ...existing, studio, alreadySaved: true });
  }

  const result = await savedStudioCollection.insertOne({
    email,
    studioId,
    createdAt: new Date().toISOString(),
  });

  res.status(201).send({ ...result, studio });
});

app.get("/studio-wishlist", verifyToken, async (req, res) => {
  const email = req.user?.email;

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  const saved = await savedStudioCollection
    .find({ email })
    .sort({ createdAt: -1 })
    .toArray();

  const studioIds = saved
    .map((item) => item.studioId)
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const studios = await studioCollection
    .find({ _id: { $in: studioIds } })
    .toArray();

  const studioMap = new Map(
    studios.map((studio) => [studio._id.toString(), studio]),
  );

  res.send(
    saved
      .map((item) => studioMap.get(item.studioId?.toString()))
      .filter(Boolean),
  );
});

app.delete("/studio-wishlist/:studioId", verifyToken, async (req, res) => {
  const email = req.user?.email;
  const studioId = String(req.params.studioId);

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  const result = await savedStudioCollection.deleteOne({ email, studioId });
  res.send(result);
});

app.get("/", (req, res) => {
  res.send({ message: "Server is running" });
});

app.listen(PORT, () => {
  console.log(`Server is running successfully on ${PORT}`);
});

export default app;
