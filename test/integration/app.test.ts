import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("raiji-chat-app");
  delete process.env.RABBITMQ_URI; // sem broker: o chat sobe mesmo assim
});

afterAll(async () => {
  await mongo.stop();
});

describe("buildApp (composição real)", () => {
  it("sobe sem RabbitMQ, responde /health e protege as rotas", async () => {
    const { buildApp } = await import("../../src/app");
    const app = buildApp();
    const warn = vi.spyOn(app.log, "warn");
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    // sem broker, publishEvent só registra no log
    app.publishEvent("raiji.chat", "message.created", { x: 1 });
    expect(warn).toHaveBeenCalledWith({ routingKey: "message.created" }, expect.any(String));

    const protectedRoute = await app.inject({ method: "GET", url: "/conversations" });
    expect(protectedRoute.statusCode).toBe(401);
    expect(protectedRoute.json()).toMatchObject({ error: "missing_token" });

    await app.close();
  });
});
