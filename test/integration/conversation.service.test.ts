import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { ConversationMemberModel } from "../../src/modules/conversations/conversation-member.model";
import { buildDirectKey, ConversationModel } from "../../src/modules/conversations/conversation.model";
import { GroupModel } from "../../src/modules/conversations/group.model";
import {
  addMembers,
  assertNotManagedByRide,
  createGroup,
  deleteConversation,
  describeConversations,
  findOrCreateDirect,
  listConversations,
  markRead,
  openDirect,
  requireConversation,
  requireGroup,
} from "../../src/modules/conversations/conversation.service";
import { MessageModel } from "../../src/modules/messages/message.model";
import { UserModel } from "../../src/modules/users/user.model";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";
import { USERS } from "../helpers/app";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

describe("buildDirectKey", () => {
  it("não depende da ordem dos participantes", () => {
    expect(buildDirectKey("b", "a")).toBe("a:b");
    expect(buildDirectKey("a", "b")).toBe("a:b");
  });
});

describe("addMembers", () => {
  it("não faz nada sem usuários", async () => {
    const conversation = await ConversationModel.create({ type: "group" });
    await addMembers(conversation._id, []);
    expect(await ConversationMemberModel.countDocuments()).toBe(0);
  });

  it("ignora ids repetidos e é idempotente", async () => {
    const conversation = await ConversationModel.create({ type: "group" });
    await addMembers(conversation._id, ["a", "b", "a"]);
    await addMembers(conversation._id, ["a", "c"]);

    const members = await ConversationMemberModel.find({ conversationId: conversation._id }).lean();
    expect(members.map((m) => m.userId).sort()).toEqual(["a", "b", "c"]);
    expect(members.every((m) => m.joinedAt instanceof Date)).toBe(true);
  });
});

describe("findOrCreateDirect", () => {
  it("cria uma única conversa entre as mesmas pessoas", async () => {
    const first = await findOrCreateDirect("user-b", "user-a");
    const second = await findOrCreateDirect("user-a", "user-b");

    expect(String(first._id)).toBe(String(second._id));
    expect(first.type).toBe("direct");
    expect(first.directKey).toBe("user-a:user-b");
    expect(await ConversationModel.countDocuments()).toBe(1);
    expect(await ConversationMemberModel.countDocuments({ conversationId: first._id })).toBe(2);
  });
});

describe("createGroup", () => {
  it("cria o grupo e todos os membros", async () => {
    const { conversation, group } = await createGroup("Família", "user-a", ["user-b", "user-c"]);
    expect(conversation.type).toBe("group");
    expect(group.name).toBe("Família");
    expect(group.createdBy).toBe("user-a");

    const members = await ConversationMemberModel.find({ conversationId: conversation._id }).lean();
    expect(members.map((m) => m.userId).sort()).toEqual(["user-a", "user-b", "user-c"]);
  });

  it("desfaz a conversa quando o grupo falha", async () => {
    vi.spyOn(GroupModel, "create").mockRejectedValueOnce(new Error("falha"));
    await expect(createGroup("X", "user-a", [])).rejects.toThrow("falha");
    expect(await ConversationModel.countDocuments()).toBe(0);
  });
});

describe("deleteConversation", () => {
  it("remove conversa, membros, grupo e mensagens", async () => {
    const { conversation } = await createGroup("Grupo", "user-a", ["user-b"]);
    await MessageModel.create({ conversationId: conversation._id, senderId: "user-a", text: "oi" });

    await deleteConversation(conversation._id);

    expect(await ConversationModel.countDocuments()).toBe(0);
    expect(await ConversationMemberModel.countDocuments()).toBe(0);
    expect(await GroupModel.countDocuments()).toBe(0);
    expect(await MessageModel.countDocuments()).toBe(0);
  });
});

describe("requireConversation", () => {
  it("responde 404 quando não existe", async () => {
    await expect(requireConversation(String(new Types.ObjectId()), USERS.ana)).rejects.toMatchObject({
      statusCode: 404,
      code: "conversation_not_found",
    });
  });

  it("libera para membros", async () => {
    const direct = await findOrCreateDirect("user-ana", "user-bruno");
    const found = await requireConversation(String(direct._id), USERS.ana);
    expect(String(found._id)).toBe(String(direct._id));
  });

  it("esconde a conversa de quem não é membro", async () => {
    const direct = await findOrCreateDirect("user-ana", "user-bruno");
    await expect(requireConversation(String(direct._id), USERS.carla)).rejects.toMatchObject({
      statusCode: 404,
      code: "conversation_not_found",
    });
  });

  it("não mostra conversa expirada para membro comum", async () => {
    const direct = await findOrCreateDirect("user-ana", "user-bruno");
    await ConversationModel.updateOne({ _id: direct._id }, { expiresAt: new Date(Date.now() - 1000) });
    await expect(requireConversation(String(direct._id), USERS.ana)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("admin acessa qualquer conversa, inclusive expirada", async () => {
    const direct = await findOrCreateDirect("user-ana", "user-bruno");
    await ConversationModel.updateOne({ _id: direct._id }, { expiresAt: new Date(Date.now() - 1000) });
    const found = await requireConversation(String(direct._id), USERS.admin);
    expect(String(found._id)).toBe(String(direct._id));
  });
});

describe("requireGroup", () => {
  it("404 para conversa direta", async () => {
    const direct = await findOrCreateDirect("user-ana", "user-bruno");
    await expect(requireGroup(String(direct._id), USERS.ana)).rejects.toMatchObject({
      statusCode: 404,
      code: "group_not_found",
    });
  });

  it("404 quando falta o documento do grupo", async () => {
    const conversation = await ConversationModel.create({ type: "group" });
    await addMembers(conversation._id, ["user-ana"]);
    await expect(requireGroup(String(conversation._id), USERS.ana)).rejects.toMatchObject({
      statusCode: 404,
      code: "group_not_found",
    });
  });

  it("dá permissão ao criador e ao admin", async () => {
    const { conversation } = await createGroup("Grupo", "user-ana", ["user-bruno"]);
    const id = String(conversation._id);

    expect((await requireGroup(id, USERS.ana)).canManage).toBe(true);
    expect((await requireGroup(id, USERS.bruno)).canManage).toBe(false);
    expect((await requireGroup(id, USERS.admin)).canManage).toBe(true);
  });
});

describe("assertNotManagedByRide", () => {
  it("bloqueia alterações de membros em grupos de carona", () => {
    expect(() => assertNotManagedByRide({ rideId: "ride-1" }, USERS.ana)).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "managed_by_ride" }),
    );
  });

  it("admin e grupos comuns passam", () => {
    expect(() => assertNotManagedByRide({ rideId: "ride-1" }, USERS.admin)).not.toThrow();
    expect(() => assertNotManagedByRide({ rideId: null }, USERS.ana)).not.toThrow();
    expect(() => assertNotManagedByRide({}, USERS.ana)).not.toThrow();
  });
});

describe("listConversations", () => {
  it("lista as conversas do usuário, com grupo e filtro por tipo", async () => {
    const direct = await findOrCreateDirect("user-ana", "user-bruno");
    const { conversation: group } = await createGroup("Equipe", "user-ana", ["user-carla"]);
    await findOrCreateDirect("user-bruno", "user-carla"); // não é da Ana

    const all = await listConversations("user-ana", { limit: 10, offset: 0 });
    expect(all.map((c) => String(c._id)).sort()).toEqual([String(direct._id), String(group._id)].sort());
    expect(all.find((c) => String(c._id) === String(group._id))?.group?.name).toBe("Equipe");
    expect(all.find((c) => String(c._id) === String(direct._id))?.group).toBeNull();

    const groups = await listConversations("user-ana", { limit: 10, offset: 0 }, "group");
    expect(groups).toHaveLength(1);
    const directs = await listConversations("user-ana", { limit: 10, offset: 0 }, "direct");
    expect(directs).toHaveLength(1);

    expect(await listConversations("user-ana", { limit: 1, offset: 5 })).toHaveLength(0);
  });
});

describe("openDirect", () => {
  it("abre/reabre a conversa atualizando nomes, papéis e assunto", async () => {
    const conversation = await openDirect(USERS.ana, {
      userId: "user-bruno",
      name: "Bruno (motorista)",
      role: "driver",
      myRole: "passenger",
      context: {
        kind: "ride",
        refId: "ride-1",
        label: "São Paulo → Campinas",
        origin: "São Paulo",
        destination: "Campinas",
        subId: "sub-1",
      },
    });

    const members = await ConversationMemberModel.find({ conversationId: conversation._id }).lean();
    expect(members.find((m) => m.userId === "user-bruno")).toMatchObject({ name: "Bruno (motorista)", role: "driver" });
    expect(members.find((m) => m.userId === "user-ana")).toMatchObject({ name: "Ana Souza", role: "passenger" });

    const stored = await ConversationModel.findById(conversation._id).lean();
    expect(stored?.context).toMatchObject({ kind: "ride", refId: "ride-1", subId: "sub-1" });
  });

  it("funciona sem nome, papel ou assunto", async () => {
    const conversation = await openDirect(USERS.admin, { userId: "user-bruno" });
    expect(conversation.type).toBe("direct");
    const members = await ConversationMemberModel.find({ conversationId: conversation._id }).lean();
    expect(members.find((m) => m.userId === "user-bruno")?.name).toBeNull();
    expect(members.find((m) => m.userId === "user-admin")?.name).toBe("Admin");
  });
});

describe("markRead", () => {
  it("grava lastReadAt do membro", async () => {
    const direct = await findOrCreateDirect("user-ana", "user-bruno");
    await markRead(direct._id, "user-ana");
    const member = await ConversationMemberModel.findOne({ conversationId: direct._id, userId: "user-ana" }).lean();
    expect(member?.lastReadAt).toBeInstanceOf(Date);
  });
});

describe("describeConversations", () => {
  it("devolve lista vazia sem conversas", async () => {
    expect(await describeConversations([], "user-ana")).toEqual([]);
  });

  it("descreve membros, nomes do cadastro, grupo, última mensagem e não lidas", async () => {
    const { conversation } = await createGroup("Equipe", "user-ana", ["user-bruno"]);
    await UserModel.create({ keycloakId: "user-bruno", name: "Bruno Lima" });
    await ConversationMemberModel.updateOne(
      { conversationId: conversation._id, userId: "user-ana" },
      { lastReadAt: new Date(Date.now() - 60_000) },
    );
    await MessageModel.create({ conversationId: conversation._id, senderId: "user-bruno", text: "antiga" });
    await MessageModel.collection.insertOne({
      _id: new Types.ObjectId(),
      conversationId: conversation._id,
      senderId: "user-bruno",
      text: "nova",
      attachments: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const docs = await ConversationModel.find({ _id: conversation._id }).lean();
    const [described] = await describeConversations(docs, "user-ana");

    expect(described.group).toEqual({ name: "Equipe" });
    expect(described.lastMessage?.text).toBe("nova");
    expect(described.unreadCount).toBe(2);
    expect(described.members).toEqual(
      expect.arrayContaining([
        { userId: "user-ana", name: null, role: null },
        { userId: "user-bruno", name: "Bruno Lima", role: null },
      ]),
    );
  });

  it("usa o nome informado na conversa quando o usuário ainda não tem cadastro", async () => {
    const conversation = await openDirect(USERS.ana, { userId: "user-carla", name: "Carla do app" });
    const docs = await ConversationModel.find({ _id: conversation._id }).lean();
    const [described] = await describeConversations(docs, "user-ana");
    expect(described.members.find((m) => m.userId === "user-carla")?.name).toBe("Carla do app");
    expect(described.lastMessage).toBeNull();
    expect(described.unreadCount).toBe(0);
  });
});
