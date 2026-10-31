import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

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

app.get("/categories", async (req, res) => {
  const result = await categoryCollection.find().toArray();
  res.send(result);
});

app.get("/studios", async (req, res) => {
  const result = await studioCollection.find().toArray();
  res.send(result);
});

app.get("/featured-studios", async (req, res) => {
  const result = await studioCollection
    .find()
    .sort({ rating: -1 })
    .limit(6)
    .toArray();
  res.send(result);
});

app.get("/studios/:id", async (req, res) => {
  const { id } = req.params;
  const result = await studioCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

app.patch("/studios/:id", async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  const result = await studioCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: data },
  );
  res.json(result);
});

app.post("/add-studio", async (req, res) => {
  const data = req.body;
  const result = await studioCollection.insertOne(data);
  res.send(result);
});

app.get("/", (req, res) => {
  res.send({ message: "Server is running" });
});

app.listen(PORT, () => {
  console.log(`Server is running successfully on ${PORT}`);
});
