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
const studioRatings = db.collection("ratings");
const savedStudioCollection = db.collection("wishlist");

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const attachStudioRatings = [
  {
    $lookup: {
      from: "ratings",
      let: { studioId: { $toString: "$_id" } },
      pipeline: [
        { $match: { $expr: { $eq: ["$studioId", "$$studioId"] } } },
        { $project: { _id: 0, rating: 1 } },
      ],
      as: "ratings",
    },
  },
];

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

const verifyOptionalToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return next();
  }

  const JWKS = createRemoteJWKSet(
    new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
  );

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
  } catch (error) {}

  next();
};

app.get("/categories", async (req, res) => {
  const result = await categoryCollection.find().toArray();
  res.send(result);
});

app.post("/add-studio", verifyToken, async (req, res) => {
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  const data = {
    ...req.body,
    hostEmail: email,
    hostName: req.user?.name || req.body?.hostName,
  };

  const result = await studioCollection.insertOne(data);
  res.send(result);
});

app.get("/studios", async (req, res) => {
  const result = await studioCollection
    .aggregate(attachStudioRatings)
    .toArray();
  res.send(result);
});

app.get("/my-studios", verifyToken, async (req, res) => {
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  const result = await studioCollection
    .find({
      hostEmail: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
    })
    .toArray();
  res.send(result);
});

app.get("/featured-studios", verifyOptionalToken, async (req, res) => {
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  const query = email
    ? {
        hostEmail: {
          $not: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
        },
      }
    : {};

  const result = await studioCollection
    .aggregate([
      { $match: query },
      { $sort: { hourlyRate: -1 } },
      { $limit: 6 },
      ...attachStudioRatings,
    ])
    .toArray();
  res.send(result);
});

app.get("/ratings/:studioId", verifyOptionalToken, async (req, res) => {
  const { studioId } = req.params;

  if (!ObjectId.isValid(studioId)) {
    return res.status(404).send({ message: "Studio not found." });
  }

  const ratings = await studioRatings
    .find({ studioId })
    .sort({ createdAt: -1 })
    .project({ _id: 1, userName: 1, rating: 1, createdAt: 1 })
    .toArray();

  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  const viewerRating = email
    ? ((
        await studioRatings.findOne(
          { studioId, email },
          { projection: { rating: 1 } },
        )
      )?.rating ?? null)
    : null;

  res.send({ ratings, viewerRating });
});

app.post("/ratings", verifyToken, async (req, res) => {
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();
  const studioId = String(req.body?.studioId ?? "");
  const rating = Number(req.body?.rating);
  const userName = String(req.body?.userName ?? req.user?.name ?? "").trim();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (!ObjectId.isValid(studioId)) {
    return res.status(404).send({ message: "Studio not found." });
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res
      .status(400)
      .send({ message: "Rating must be a whole number between 1 and 5." });
  }

  const studio = await studioCollection.findOne({
    _id: new ObjectId(studioId),
  });

  if (!studio) {
    return res.status(404).send({ message: "Studio not found." });
  }

  if (
    String(studio.hostEmail ?? "")
      .trim()
      .toLowerCase() === email
  ) {
    return res
      .status(403)
      .send({ message: "You cannot rate your own studio." });
  }

  const existingRating = await studioRatings.findOne({ studioId, email });

  if (existingRating) {
    return res
      .status(409)
      .send({ message: "You have already rated this studio." });
  }

  const now = new Date().toISOString();

  await studioRatings.insertOne({
    studioId,
    email,
    userName,
    rating,
    createdAt: now,
  });

  res.send({ rating });
});

app.get("/studios/:id", async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(404).send({ message: "Studio not found." });
  }

  const result = await studioCollection.findOne({ _id: new ObjectId(id) });

  if (!result) {
    return res.status(404).send({ message: "Studio not found." });
  }

  res.send(result);
});

app.patch("/studios/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (!ObjectId.isValid(id)) {
    return res.status(404).send({ message: "Studio not found." });
  }

  const studio = await studioCollection.findOne({ _id: new ObjectId(id) });

  if (!studio) {
    return res.status(404).send({ message: "Studio not found." });
  }

  if (
    String(studio.hostEmail ?? "")
      .trim()
      .toLowerCase() !== email
  ) {
    return res
      .status(403)
      .send({ message: "You can only edit your own studios." });
  }

  const data = { ...req.body, hostEmail: email };
  delete data._id;

  const result = await studioCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: data },
  );

  res.json(result);
});

app.delete("/studios/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (!ObjectId.isValid(id)) {
    return res.status(404).send({ message: "Studio not found." });
  }

  const studio = await studioCollection.findOne({ _id: new ObjectId(id) });

  if (!studio) {
    return res.status(404).send({ message: "Studio not found." });
  }

  if (
    String(studio.hostEmail ?? "")
      .trim()
      .toLowerCase() !== email
  ) {
    return res
      .status(403)
      .send({ message: "You can only delete your own studios." });
  }

  const result = await studioCollection.deleteOne({ _id: new ObjectId(id) });
  res.json(result);
});

app.post("/booking", verifyToken, async (req, res) => {
  const data = req.body;
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();
  const studioId = String(data?.studioId ?? "");

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (!ObjectId.isValid(studioId)) {
    return res.status(404).send({ message: "Studio not found." });
  }

  const studio = await studioCollection.findOne({
    _id: new ObjectId(studioId),
  });

  if (!studio) {
    return res.status(404).send({ message: "Studio not found." });
  }

  if (
    String(studio.hostEmail ?? "")
      .trim()
      .toLowerCase() === email
  ) {
    return res
      .status(403)
      .send({ message: "You cannot book your own studio." });
  }

  if (!data?.bookingDate || !data?.startTime || !data?.endTime) {
    return res.status(400).send({
      message: "Booking date, start time and end time are required.",
    });
  }

  const booking = await bookingCollection.findOne({
    studioId,
    bookingDate: data.bookingDate,
    status: { $regex: "^confirmed$", $options: "i" },
    $expr: {
      $and: [
        { $lt: ["$startTime", data.endTime] },
        { $gt: ["$endTime", data.startTime] },
      ],
    },
  });

  if (booking) {
    return res.status(409).send({
      message: `This studio already has a confirmed booking that overlaps ${data.startTime} - ${data.endTime} on ${data.bookingDate}. Please choose a different time slot.`,
    });
  }

  const result = await bookingCollection.insertOne({
    ...data,
    studioId,
    email,
    userEmail: email,
  });
  res.send(result);
});

app.get("/my-bookings/:email", verifyToken, async (req, res) => {
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();
  const requestedEmail = String(req.params.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (requestedEmail !== email) {
    return res
      .status(403)
      .send({ message: "You can only view your own bookings." });
  }

  const result = await bookingCollection
    .find({ email: requestedEmail })
    .toArray();
  res.send(result);
});

app.patch("/my-bookings/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (!ObjectId.isValid(id)) {
    return res.status(404).send({ message: "Booking not found." });
  }

  const booking = await bookingCollection.findOne({ _id: new ObjectId(id) });

  if (!booking) {
    return res.status(404).send({ message: "Booking not found." });
  }

  const ownerEmail = String(booking.email ?? booking.userEmail ?? "")
    .trim()
    .toLowerCase();

  if (ownerEmail !== email) {
    return res
      .status(403)
      .send({ message: "You can only update your own bookings." });
  }

  const data = { ...req.body };
  delete data._id;
  delete data.email;
  delete data.userEmail;

  const result = await bookingCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: data },
  );
  res.json(result);
});

app.delete("/my-bookings/:id", verifyToken, async (req, res) => {
  const { id } = req.params;
  const email = String(req.user?.email ?? "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(401).send({ message: "Unauthorized!" });
  }

  if (!ObjectId.isValid(id)) {
    return res.status(404).send({ message: "Booking not found." });
  }

  const booking = await bookingCollection.findOne({ _id: new ObjectId(id) });

  if (!booking) {
    return res.status(404).send({ message: "Booking not found." });
  }

  const ownerEmail = String(booking.email ?? booking.userEmail ?? "")
    .trim()
    .toLowerCase();

  if (ownerEmail !== email) {
    return res
      .status(403)
      .send({ message: "You can only remove your own bookings." });
  }

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
