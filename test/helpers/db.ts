import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

let server: MongoMemoryServer | undefined;

/** Sobe um MongoDB efêmero em memória para os testes de serviço/rota. */
export async function connectTestDb() {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "raiji-chat-test" });
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
  await server?.stop();
  server = undefined;
}

export async function clearDb() {
  const db = mongoose.connection.db;
  if (!db) return;
  const collections = await db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
