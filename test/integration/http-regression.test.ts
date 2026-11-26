import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * [Regressão][Análise de Falhas] Rotas HTTP do MESSAGE-SERVICE.
 *
 * Sobe o app real (com plugins de infraestrutura mockados) e usa `inject`,
 * sem porta e sem MongoDB/RabbitMQ. O foco é o contrato de erro que o app e o
 * backend consomem: 400/401/404/409/500 com códigos estáveis.
 */
vi.mock("../../src/plugins/mongo", () => ({ default: async () => {} }));

vi.mock("../../src/plugins/rabbitmq", () => ({
  default: async () => {},
  CHAT_EXCHANGE: "raiji.chat",
}));

vi.mock("../../src/plugins/auth", async () => {
  const fp = (await import("fastify-plugin")).default;
  const { HttpError } = await import("../../src/shared/errors");
  return {
    default: fp(async (app) => {
      app.decorateRequest("user", null);
      app.decorate("authenticate", async (req) => {
        if (!req.headers.authorization) throw new HttpError(401, "missing_token");
        req.user = { id: "u1", isAdmin: false, name: "Ana" };
      });
    }),
  };
});

vi.mock("../../src/modules/conversations/expiration.job", () => ({
  startExpirationJob: () => () => {},
}));

vi.mock("../../src/modules/users/user.service", () => ({
  rememberName: vi.fn(async () => {}),
  ensureUser: vi.fn(),
  deleteUserCascade: vi.fn(),
}));

vi.mock("../../src/modules/conversations/conversation.service", () => ({
  addMembers: vi.fn(),
  assertNotManagedByRide: vi.fn(),
  deleteConversation: vi.fn(),
  describeConversations: vi.fn(async (conversations: unknown[]) => conversations),
  listConversations: vi.fn(async () => []),
  markRead: vi.fn(),
  openDirect: vi.fn(),
  requireConversation: vi.fn(async () => ({ _id: "c1", type: "direct" })),
  requireGroup: vi.fn(async () => ({
    conversation: { _id: "c1", rideId: null },
    group: { createdBy: "u1" },
    canManage: true,
  })),
}));

vi.mock("../../src/modules/messages/message.service", () => ({
  createUpload: vi.fn(async () => ({ attachment: { id: "a1" }, upload: { url: "https://s3" } })),
  listMessages: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({
    id: "m1",
    senderId: "u1",
    text: "oi",
    attachments: [],
    sentAt: new Date("2026-11-26T12:00:00.000Z").toISOString(),
  })),
  toPreviewDto: vi.fn(),
  deleteConversationMedia: vi.fn(),
}));

vi.mock("../../src/modules/messages/message-events", () => ({
  messageCreatedEvent: vi.fn(async () => null),
}));

import { buildApp } from "../../src/app";
import { HttpError } from "../../src/shared/errors";

const AUTH = { authorization: "Bearer token" };
const ID = "64b7f0a1b2c3d4e5f6a7b8c9";

let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  app = buildApp();
});

afterEach(async () => {
  await app.close();
});

describe("[Regressão] autenticação e listagem", () => {
  it("sem token responde 401 com código estável", async () => {
    const response = await app.inject({ method: "GET", url: "/conversations" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "missing_token" });
  });

  it("com token lista conversas (contrato do app)", async () => {
    const response = await app.inject({ method: "GET", url: "/conversations?limit=20", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("[Análise de Falhas] validação de entrada", () => {
  it("id de conversa inválido vira 400, nunca 500", async () => {
    const response = await app.inject({ method: "GET", url: "/conversations/nao-e-object-id", headers: AUTH });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("paginação acima do limite vira 400", async () => {
    const response = await app.inject({ method: "GET", url: "/conversations?limit=101", headers: AUTH });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("corpo inválido de conversa direta vira 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/conversations/direct",
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("não permite abrir conversa consigo mesmo", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/conversations/direct",
      headers: AUTH,
      payload: { userId: "u1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_recipient" });
  });

  it("mensagem com mais de 5 anexos vira 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${ID}/messages`,
      headers: AUTH,
      payload: { attachmentIds: Array.from({ length: 6 }, () => ID) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("anexo com tamanho zero vira 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${ID}/attachments`,
      headers: AUTH,
      payload: { name: "a.png", mimeType: "image/png", sizeBytes: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("[Regressão] rotas de conversa", () => {
  it("marcar como lida responde 204", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${ID}/read`,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("envio de mensagem responde 201 com o DTO", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${ID}/messages`,
      headers: AUTH,
      payload: { text: "oi" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "m1", senderId: "u1", text: "oi" });
  });
});

describe("[Análise de Falhas] error handler global", () => {
  beforeEach(() => {
    app.get("/__test/http-error", async () => {
      throw new HttpError(409, "conflict");
    });
    app.get("/__test/duplicate", async () => {
      throw Object.assign(new Error("duplicado"), { code: 11000 });
    });
    app.get("/__test/status", async () => {
      throw Object.assign(new Error("dados inválidos"), { statusCode: 422 });
    });
    app.get("/__test/boom", async () => {
      throw new Error("segredo interno do banco");
    });
    app.post("/__test/zod", async () => {
      z.object({ name: z.string().min(1) }).parse({});
    });
  });

  it("HttpError mantém status e código", async () => {
    const response = await app.inject({ method: "GET", url: "/__test/http-error" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "conflict" });
  });

  it("violação de unicidade do Mongo vira 409", async () => {
    const response = await app.inject({ method: "GET", url: "/__test/duplicate" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "conflict" });
  });

  it("statusCode < 500 é exposto como invalid_request", async () => {
    const response = await app.inject({ method: "GET", url: "/__test/status" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_request", message: "dados inválidos" });
  });

  it("ZodError vira 400 com issues", async () => {
    const response = await app.inject({ method: "POST", url: "/__test/zod", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
    expect((response.json() as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it("erro inesperado vira 500 sem vazar detalhes internos", async () => {
    const response = await app.inject({ method: "GET", url: "/__test/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error" });
    expect(response.body).not.toContain("segredo interno");
  });
});
