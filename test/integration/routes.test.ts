import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const { s3send } = vi.hoisted(() => ({ s3send: vi.fn() }));

vi.mock("../../src/config/storage", () => ({
  storage: { bucket: "bucket-test", internal: { send: s3send }, signer: {} },
}));
vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: vi.fn(async () => ({ url: "https://upload.example", fields: { key: "chave", policy: "p" } })),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => "https://signed.example/arquivo"),
}));

import conversationRoutes from "../../src/modules/conversations/conversation.routes";
import groupRoutes from "../../src/modules/conversations/group.routes";
import messageRoutes from "../../src/modules/messages/message.routes";
import userRoutes from "../../src/modules/users/user.routes";
import { ConversationMemberModel } from "../../src/modules/conversations/conversation-member.model";
import { ConversationModel } from "../../src/modules/conversations/conversation.model";
import { GroupModel } from "../../src/modules/conversations/group.model";
import { MessageModel } from "../../src/modules/messages/message.model";
import { PendingAttachmentModel } from "../../src/modules/messages/attachment.model";
import { UserModel } from "../../src/modules/users/user.model";
import { buildTestApp, USERS, type TestApp } from "../helpers/app";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

let h: TestApp;

beforeEach(async () => {
  await clearDb();
  s3send.mockReset().mockResolvedValue({ ContentLength: 10 });
  h = await buildTestApp(userRoutes, conversationRoutes, groupRoutes, messageRoutes);
  h.as(USERS.ana);
});

afterEach(async () => {
  await h.app.close();
});

const json = <T = unknown>(res: { payload: string }): T => JSON.parse(res.payload) as T;

async function makeGroup(creator = "user-ana", members: string[] = ["user-ana", "user-bruno"]) {
  const conversation = await ConversationModel.create({ type: "group" });
  const group = await GroupModel.create({ conversationId: conversation._id, name: "Grupo", createdBy: creator });
  await ConversationMemberModel.insertMany(members.map((userId) => ({ conversationId: conversation._id, userId })));
  return { conversation, group, id: String(conversation._id) };
}

describe("rotas de usuários", () => {
  it("GET /users/me cria o usuário logado", async () => {
    const res = await h.app.inject({ method: "GET", url: "/users/me" });
    expect(res.statusCode).toBe(200);
    expect(json<{ keycloakId: string }>(res).keycloakId).toBe("user-ana");
  });

  it("GET /users exige admin", async () => {
    expect((await h.app.inject({ method: "GET", url: "/users" })).statusCode).toBe(403);
    h.as(USERS.admin);
    await UserModel.create({ keycloakId: "a" });
    await UserModel.create({ keycloakId: "b" });
    const res = await h.app.inject({ method: "GET", url: "/users?limit=1&offset=1" });
    expect(res.statusCode).toBe(200);
    expect(json<unknown[]>(res)).toHaveLength(1);
  });

  it("POST /users exige admin e cria o usuário informado", async () => {
    expect((await h.app.inject({ method: "POST", url: "/users", payload: { keycloakId: "novo" } })).statusCode).toBe(403);
    h.as(USERS.admin);
    const res = await h.app.inject({ method: "POST", url: "/users", payload: { keycloakId: "novo" } });
    expect(res.statusCode).toBe(200);
    expect(json<{ keycloakId: string }>(res).keycloakId).toBe("novo");
  });

  it("GET /users/:id libera o próprio perfil e bloqueia terceiros", async () => {
    await UserModel.create({ keycloakId: "user-ana", name: "Ana" });
    await UserModel.create({ keycloakId: "user-bruno", name: "Bruno" });

    const own = await h.app.inject({ method: "GET", url: "/users/user-ana" });
    expect(own.statusCode).toBe(200);
    expect(json<{ name: string }>(own).name).toBe("Ana");

    expect((await h.app.inject({ method: "GET", url: "/users/user-bruno" })).statusCode).toBe(403);

    h.as(USERS.admin);
    expect((await h.app.inject({ method: "GET", url: "/users/user-bruno" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/users/nao-existe" })).statusCode).toBe(404);
  });

  it("DELETE /users/:id apaga em cascata (próprio ou admin)", async () => {
    await UserModel.create({ keycloakId: "user-bruno" });
    expect((await h.app.inject({ method: "DELETE", url: "/users/user-bruno" })).statusCode).toBe(403);

    const res = await h.app.inject({ method: "DELETE", url: "/users/user-ana" });
    expect(res.statusCode).toBe(204);
    expect(await UserModel.findOne({ keycloakId: "user-ana" })).toBeNull();
  });
});

describe("rotas de conversas", () => {
  it("POST /conversations/direct cria/abre a conversa direta", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/conversations/direct",
      payload: { userId: "user-bruno", name: "Bruno", role: "driver", myRole: "passenger" },
    });
    expect(res.statusCode).toBe(200);
    const body = json<{ _id: string; members: { userId: string }[] }>(res);
    expect(body.members.map((m) => m.userId).sort()).toEqual(["user-ana", "user-bruno"]);

    const again = await h.app.inject({ method: "POST", url: "/conversations/direct", payload: { userId: "user-bruno" } });
    expect(json<{ _id: string }>(again)._id).toBe(body._id);
  });

  it("POST /conversations/direct recusa conversar consigo mesmo", async () => {
    const res = await h.app.inject({ method: "POST", url: "/conversations/direct", payload: { userId: "user-ana" } });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toBe("invalid_recipient");
  });

  it("GET /conversations lista só as conversas do usuário", async () => {
    await makeGroup();
    const res = await h.app.inject({ method: "GET", url: "/conversations" });
    expect(res.statusCode).toBe(200);
    const list = json<{ group: { name: string } | null }[]>(res);
    expect(list).toHaveLength(1);
    expect(list[0]!.group?.name).toBe("Grupo");
  });

  it("GET /conversations/:id devolve a conversa e 404 para quem não participa", async () => {
    const { id } = await makeGroup();
    const res = await h.app.inject({ method: "GET", url: `/conversations/${id}` });
    expect(res.statusCode).toBe(200);
    expect(json<{ _id: string }>(res)._id).toBe(id);

    h.as(USERS.carla);
    expect((await h.app.inject({ method: "GET", url: `/conversations/${id}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/conversations/abc" })).statusCode).toBe(400);
  });

  it("GET /conversations/by-ride/:rideId encontra o grupo da carona", async () => {
    const conversation = await ConversationModel.create({ type: "group", rideId: "ride-42" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana" });

    const res = await h.app.inject({ method: "GET", url: "/conversations/by-ride/ride-42" });
    expect(res.statusCode).toBe(200);
    expect(json<{ _id: string }>(res)._id).toBe(String(conversation._id));
    expect((await h.app.inject({ method: "GET", url: "/conversations/by-ride/nao-existe" })).statusCode).toBe(404);
  });

  it("POST /conversations/:id/read marca como lida", async () => {
    const { id } = await makeGroup();
    const res = await h.app.inject({ method: "POST", url: `/conversations/${id}/read` });
    expect(res.statusCode).toBe(204);
    const member = await ConversationMemberModel.findOne({ conversationId: id, userId: "user-ana" }).lean();
    expect(member?.lastReadAt).toBeInstanceOf(Date);
  });

  it("PATCH /conversations/:id é só para admin", async () => {
    const { id } = await makeGroup();
    const payload = { expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect((await h.app.inject({ method: "PATCH", url: `/conversations/${id}`, payload })).statusCode).toBe(403);

    h.as(USERS.admin);
    const res = await h.app.inject({ method: "PATCH", url: `/conversations/${id}`, payload });
    expect(res.statusCode).toBe(200);
    expect(json<{ expiresAt: string }>(res).expiresAt).toBe(payload.expiresAt);

    const cleared = await h.app.inject({ method: "PATCH", url: `/conversations/${id}`, payload: { expiresAt: null } });
    expect(json<{ expiresAt: string | null }>(cleared).expiresAt).toBeNull();
  });

  it("DELETE /conversations/:id é só para admin", async () => {
    const { id } = await makeGroup();
    expect((await h.app.inject({ method: "DELETE", url: `/conversations/${id}` })).statusCode).toBe(403);

    h.as(USERS.admin);
    expect((await h.app.inject({ method: "DELETE", url: `/conversations/${id}` })).statusCode).toBe(204);
    expect(await ConversationModel.findById(id)).toBeNull();
  });

  it("GET/POST/DELETE de membros respeitam permissões", async () => {
    const { id } = await makeGroup("user-ana", ["user-ana"]);

    const list = await h.app.inject({ method: "GET", url: `/conversations/${id}/members?limit=10` });
    expect(list.statusCode).toBe(200);
    expect(json<unknown[]>(list)).toHaveLength(1);

    // criador adiciona membro
    expect(
      (await h.app.inject({ method: "POST", url: `/conversations/${id}/members`, payload: { userId: "user-bruno" } })).statusCode,
    ).toBe(204);

    // membro comum não pode adicionar
    h.as(USERS.bruno);
    expect(
      (await h.app.inject({ method: "POST", url: `/conversations/${id}/members`, payload: { userId: "user-carla" } })).statusCode,
    ).toBe(403);

    // sai da conversa
    expect((await h.app.inject({ method: "DELETE", url: `/conversations/${id}/members/user-bruno` })).statusCode).toBe(204);
    // sair de novo: não é mais membro
    expect((await h.app.inject({ method: "DELETE", url: `/conversations/${id}/members/user-bruno` })).statusCode).toBe(404);

    // criador não pode ser removido por não-admin
    h.as(USERS.ana);
    expect((await h.app.inject({ method: "DELETE", url: `/conversations/${id}/members/user-ana` })).statusCode).toBe(409);
  });

  it("bloqueia alteração de membros em grupo de carona", async () => {
    const conversation = await ConversationModel.create({ type: "group", rideId: "ride-7" });
    await GroupModel.create({ conversationId: conversation._id, name: "Carona", createdBy: "user-ana" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana" });

    const res = await h.app.inject({
      method: "POST",
      url: `/conversations/${conversation._id}/members`,
      payload: { userId: "user-bruno" },
    });
    expect(res.statusCode).toBe(409);
    expect(json<{ error: string }>(res).error).toBe("managed_by_ride");
  });
});

describe("rotas de grupos", () => {
  it("POST /groups cria o grupo e GET lista", async () => {
    const res = await h.app.inject({ method: "POST", url: "/groups", payload: { name: "Viagem", memberIds: ["user-bruno"] } });
    expect(res.statusCode).toBe(201);
    const body = json<{ _id: string; group: { name: string } }>(res);
    expect(body.group.name).toBe("Viagem");

    const list = await h.app.inject({ method: "GET", url: "/groups" });
    expect(json<{ _id: string }[]>(list)).toHaveLength(1);

    const one = await h.app.inject({ method: "GET", url: `/groups/${body._id}` });
    expect(one.statusCode).toBe(200);
    expect(json<{ group: { name: string } }>(one).group.name).toBe("Viagem");
  });

  it("PATCH/DELETE exigem permissão de gestão", async () => {
    const { id } = await makeGroup("user-ana", ["user-ana", "user-bruno"]);

    h.as(USERS.bruno);
    expect((await h.app.inject({ method: "PATCH", url: `/groups/${id}`, payload: { name: "X" } })).statusCode).toBe(403);

    h.as(USERS.ana);
    const renamed = await h.app.inject({ method: "PATCH", url: `/groups/${id}`, payload: { name: "Novo nome" } });
    expect(json<{ name: string }>(renamed).name).toBe("Novo nome");

    const deleted = await h.app.inject({ method: "DELETE", url: `/groups/${id}` });
    expect(deleted.statusCode).toBe(204);
    expect(await ConversationModel.findById(id)).toBeNull();
  });

  it("não deixa apagar grupo controlado por carona", async () => {
    const conversation = await ConversationModel.create({ type: "group", rideId: "ride-8" });
    await GroupModel.create({ conversationId: conversation._id, name: "Carona", createdBy: "user-ana" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana" });

    const res = await h.app.inject({ method: "DELETE", url: `/groups/${conversation._id}` });
    expect(res.statusCode).toBe(409);
  });
});

describe("rotas de mensagens", () => {
  async function conversationWithMembers() {
    const conversation = await ConversationModel.create({ type: "direct", directKey: "user-ana:user-bruno" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana", name: "Ana" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-bruno", name: "Bruno" });
    return String(conversation._id);
  }

  it("GET /conversations/:id/messages lista e marca como lida", async () => {
    const id = await conversationWithMembers();
    await MessageModel.create({ conversationId: id, senderId: "user-bruno", text: "oi" });

    const res = await h.app.inject({ method: "GET", url: `/conversations/${id}/messages?limit=10` });
    expect(res.statusCode).toBe(200);
    expect(json<{ text: string }[]>(res)[0]!.text).toBe("oi");

    const member = await ConversationMemberModel.findOne({ conversationId: id, userId: "user-ana" }).lean();
    expect(member?.lastReadAt).toBeInstanceOf(Date);
  });

  it("GET com 'before' não altera a marcação de lida", async () => {
    const id = await conversationWithMembers();
    const before = new Date().toISOString();
    const res = await h.app.inject({ method: "GET", url: `/conversations/${id}/messages?before=${encodeURIComponent(before)}` });
    expect(res.statusCode).toBe(200);
    const member = await ConversationMemberModel.findOne({ conversationId: id, userId: "user-ana" }).lean();
    expect(member?.lastReadAt).toBeNull();
  });

  it("POST mensagem de texto publica message.created para os outros membros", async () => {
    const id = await conversationWithMembers();
    const res = await h.app.inject({ method: "POST", url: `/conversations/${id}/messages`, payload: { text: "olá" } });
    expect(res.statusCode).toBe(201);
    expect(json<{ text: string }>(res).text).toBe("olá");

    await vi.waitFor(() => expect(h.published).toHaveLength(1));
    expect(h.published[0]).toMatchObject({
      exchange: "raiji.chat",
      routingKey: "message.created",
      payload: { conversationId: id, preview: "olá", recipientIds: ["user-bruno"] },
    });
  });

  it("POST mensagem vazia devolve 400", async () => {
    const id = await conversationWithMembers();
    const res = await h.app.inject({ method: "POST", url: `/conversations/${id}/messages`, payload: { text: "" } });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toBe("empty_message");
  });

  it("POST /attachments devolve o link de upload", async () => {
    const id = await conversationWithMembers();
    const res = await h.app.inject({
      method: "POST",
      url: `/conversations/${id}/attachments`,
      payload: { name: "foto.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
    });
    expect(res.statusCode).toBe(201);
    const body = json<{ attachment: { id: string }; upload: { url: string } }>(res);
    expect(body.upload.url).toBe("https://upload.example");
    expect(await PendingAttachmentModel.countDocuments()).toBe(1);
  });

  it("POST /attachments recusa tipo não permitido (415)", async () => {
    const id = await conversationWithMembers();
    const res = await h.app.inject({
      method: "POST",
      url: `/conversations/${id}/attachments`,
      payload: { name: "x.svg", mimeType: "image/svg+xml", sizeBytes: 10 },
    });
    expect(res.statusCode).toBe(415);
  });

  it("envia mensagem com anexo já enviado ao S3", async () => {
    const id = await conversationWithMembers();
    const upload = await h.app.inject({
      method: "POST",
      url: `/conversations/${id}/attachments`,
      payload: { name: "foto.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
    });
    const attachmentId = json<{ attachment: { id: string } }>(upload).attachment.id;

    const res = await h.app.inject({
      method: "POST",
      url: `/conversations/${id}/messages`,
      payload: { attachmentIds: [attachmentId] },
    });
    expect(res.statusCode).toBe(201);
    const body = json<{ attachments: { url: string }[] }>(res);
    expect(body.attachments[0]!.url).toBe("https://signed.example/arquivo");
    expect(await PendingAttachmentModel.countDocuments()).toBe(0);
  });

  it("protege todas as rotas de mensagens por participação", async () => {
    const id = await conversationWithMembers();
    h.as(USERS.carla);
    expect((await h.app.inject({ method: "GET", url: `/conversations/${id}/messages` })).statusCode).toBe(404);
    expect(
      (await h.app.inject({ method: "POST", url: `/conversations/${id}/messages`, payload: { text: "oi" } })).statusCode,
    ).toBe(404);
  });

  it("valida parâmetros de rota e de consulta", async () => {
    expect((await h.app.inject({ method: "GET", url: "/conversations/xyz/messages" })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "GET", url: `/conversations/${new Types.ObjectId()}/messages?limit=0` })).statusCode).toBe(400);
  });
});
