import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Regressão][Análise de Falhas] conversation.service.
 *
 * Fixa as regras que protegem o chat: quem pode ver a conversa, quem gerencia
 * o grupo, o que acontece com grupos controlados pela carona e a limpeza em
 * cascata.
 */
const conversationFindOne = vi.hoisted(() => vi.fn());
const conversationFind = vi.hoisted(() => vi.fn());
const conversationCreate = vi.hoisted(() => vi.fn());
const conversationFindOneAndUpdate = vi.hoisted(() => vi.fn());
const conversationUpdateOne = vi.hoisted(() => vi.fn());
const conversationDeleteOne = vi.hoisted(() => vi.fn());

const memberExists = vi.hoisted(() => vi.fn());
const memberFind = vi.hoisted(() => vi.fn());
const memberBulkWrite = vi.hoisted(() => vi.fn());
const memberUpdateOne = vi.hoisted(() => vi.fn());
const memberDeleteMany = vi.hoisted(() => vi.fn());

const groupFind = vi.hoisted(() => vi.fn());
const groupFindOne = vi.hoisted(() => vi.fn());
const groupCreate = vi.hoisted(() => vi.fn());
const groupDeleteOne = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/conversations/conversation.model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/modules/conversations/conversation.model")>();
  return {
    ...actual,
    ConversationModel: {
      find: conversationFind,
      findOne: conversationFindOne,
      create: conversationCreate,
      findOneAndUpdate: conversationFindOneAndUpdate,
      updateOne: conversationUpdateOne,
      deleteOne: conversationDeleteOne,
    },
  };
});
vi.mock("../../src/modules/conversations/conversation-member.model", () => ({
  ConversationMemberModel: {
    exists: memberExists,
    find: memberFind,
    bulkWrite: memberBulkWrite,
    updateOne: memberUpdateOne,
    deleteMany: memberDeleteMany,
  },
}));
vi.mock("../../src/modules/conversations/group.model", () => ({
  GroupModel: { find: groupFind, findOne: groupFindOne, create: groupCreate, deleteOne: groupDeleteOne },
}));
vi.mock("../../src/modules/messages/message.service", () => ({
  deleteConversationMedia: vi.fn(async () => {}),
  toPreviewDto: vi.fn(),
}));
vi.mock("../../src/modules/users/user.model", () => ({ UserModel: { find: vi.fn() } }));
vi.mock("../../src/modules/messages/message.model", () => ({ MessageModel: { findOne: vi.fn(), countDocuments: vi.fn() } }));

import { HttpError } from "../../src/shared/errors";
import {
  addMembers,
  assertNotManagedByRide,
  createGroup,
  deleteConversation,
  findOrCreateDirect,
  listConversations,
  openDirect,
  requireConversation,
  requireGroup,
} from "../../src/modules/conversations/conversation.service";

const user = { id: "u1", isAdmin: false, name: "Ana" };
const admin = { id: "admin", isAdmin: true, name: "Admin" };

const expectHttpError = (fn: () => Promise<unknown>, status: number, code: string) =>
  expect(fn()).rejects.toMatchObject({ statusCode: status, code } satisfies Partial<HttpError>);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("[Regressão] buildDirectKey", () => {
  it("ordena os dois ids para a conversa direta ser única", async () => {
    const { buildDirectKey } = await import("../../src/modules/conversations/conversation.model");
    expect(buildDirectKey("b", "a")).toBe("a:b");
    expect(buildDirectKey("a", "b")).toBe("a:b");
  });
});

describe("[Análise de Falhas] requireConversation", () => {
  it("não revela conversa inexistente: 404", async () => {
    conversationFindOne.mockResolvedValue(null);
    await expectHttpError(() => requireConversation("c1", user), 404, "conversation_not_found");
  });

  it("não revela conversa da qual não participa: 404", async () => {
    conversationFindOne.mockResolvedValue({ _id: "c1" });
    memberExists.mockResolvedValue(null);
    await expectHttpError(() => requireConversation("c1", user), 404, "conversation_not_found");
  });

  it("membro recebe a conversa; consulta ignora expiradas", async () => {
    const conversation = { _id: "c1", type: "direct" };
    conversationFindOne.mockResolvedValue(conversation);
    memberExists.mockResolvedValue({ _id: "m1" });

    await expect(requireConversation("c1", user)).resolves.toBe(conversation);
    expect(conversationFindOne).toHaveBeenCalledWith({
      _id: "c1",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: expect.any(Date) } }],
    });
  });

  it("admin vê a conversa sem checar participação", async () => {
    const conversation = { _id: "c1", type: "direct" };
    conversationFindOne.mockResolvedValue(conversation);

    await expect(requireConversation("c1", admin)).resolves.toBe(conversation);
    expect(memberExists).not.toHaveBeenCalled();
  });
});

describe("[Análise de Falhas] requireGroup", () => {
  it("conversa direta não é grupo: 404", async () => {
    conversationFindOne.mockResolvedValue({ _id: "c1", type: "direct" });
    memberExists.mockResolvedValue({ _id: "m1" });
    groupFindOne.mockResolvedValue(null);

    await expectHttpError(() => requireGroup("c1", user), 404, "group_not_found");
  });

  it("criador gerencia; membro comum não", async () => {
    const conversation = { _id: "c1", type: "group", rideId: null };
    conversationFindOne.mockResolvedValue(conversation);
    memberExists.mockResolvedValue({ _id: "m1" });
    groupFindOne.mockResolvedValue({ createdBy: "u1" });

    await expect(requireGroup("c1", user)).resolves.toMatchObject({ canManage: true });
    await expect(requireGroup("c1", { ...user, id: "u2" })).resolves.toMatchObject({ canManage: false });
  });
});

describe("[Análise de Falhas] assertNotManagedByRide", () => {
  it("bloqueia alteração manual em grupo de carona, exceto admin", () => {
    expect(() => assertNotManagedByRide({ rideId: "r1" }, user)).toThrow(HttpError);
    expect(() => assertNotManagedByRide({ rideId: "r1" }, admin)).not.toThrow();
    expect(() => assertNotManagedByRide({ rideId: null }, user)).not.toThrow();
  });
});

describe("[Regressão] addMembers", () => {
  it("não escreve nada sem membros", async () => {
    await addMembers("c1", []);
    expect(memberBulkWrite).not.toHaveBeenCalled();
  });

  it("remove duplicados e faz upsert idempotente", async () => {
    await addMembers("c1", ["u1", "u2", "u1"]);

    expect(memberBulkWrite).toHaveBeenCalledTimes(1);
    const operations = memberBulkWrite.mock.calls[0]![0] as Array<{ updateOne: { filter: unknown } }>;
    expect(operations).toHaveLength(2);
    expect(operations.map((o) => o.updateOne.filter)).toEqual([
      { conversationId: "c1", userId: "u1" },
      { conversationId: "c1", userId: "u2" },
    ]);
  });
});

describe("[Regressão] criação de conversas", () => {
  it("findOrCreateDirect usa chave ordenada e adiciona os dois membros", async () => {
    conversationFindOneAndUpdate.mockResolvedValue({ _id: "c1" });

    await findOrCreateDirect("b", "a");

    expect(conversationFindOneAndUpdate).toHaveBeenCalledWith(
      { directKey: "a:b" },
      { $setOnInsert: { type: "direct" } },
      { upsert: true, returnDocument: "after" },
    );
    expect(memberBulkWrite).toHaveBeenCalledTimes(1);
  });

  it("createGroup cria grupo e membros", async () => {
    const conversation = { _id: "c1", type: "group" };
    const group = { conversationId: "c1", name: "Time", createdBy: "u1" };
    conversationCreate.mockResolvedValue(conversation);
    groupCreate.mockResolvedValue(group);

    await expect(createGroup("Time", "u1", ["u2"])).resolves.toEqual({ conversation, group });
    expect(conversationCreate).toHaveBeenCalledWith({ type: "group" });
    expect(groupCreate).toHaveBeenCalledWith({ conversationId: "c1", name: "Time", createdBy: "u1" });
  });

  it("se o grupo falhar, apaga a conversa recém-criada", async () => {
    conversationCreate.mockResolvedValue({ _id: "c1" });
    groupCreate.mockRejectedValue(new Error("falha no grupo"));

    await expect(createGroup("Time", "u1", ["u2"])).rejects.toThrow("falha no grupo");
    expect(conversationDeleteOne).toHaveBeenCalledWith({ _id: "c1" });
  });

  it("openDirect atualiza papéis, nomes e contexto", async () => {
    conversationFindOneAndUpdate.mockResolvedValue({ _id: "c1" });
    memberUpdateOne.mockResolvedValue({});
    conversationUpdateOne.mockResolvedValue({});

    await openDirect(user, {
      userId: "u2",
      name: "Bia",
      role: "passenger",
      myRole: "driver",
      context: {
        kind: "ride",
        refId: "r1",
        label: "Carona",
        origin: "SP",
        destination: "Campinas",
      },
    });

    expect(memberUpdateOne).toHaveBeenCalledWith(
      { conversationId: "c1", userId: "u2" },
      { $set: { name: "Bia", role: "passenger" } },
    );
    expect(memberUpdateOne).toHaveBeenCalledWith(
      { conversationId: "c1", userId: "u1" },
      { $set: { name: "Ana", role: "driver" } },
    );
    expect(conversationUpdateOne).toHaveBeenCalledWith(
      { _id: "c1" },
      { $set: { context: expect.objectContaining({ kind: "ride", refId: "r1" }) } },
    );
  });
});

describe("[Regressão] listConversations", () => {
  it("junta o grupo e respeita paginação/ordenação", async () => {
    memberFind.mockReturnValue({ distinct: vi.fn(async () => ["c1"]) });
    const chain = {
      sort: vi.fn(() => chain),
      skip: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      lean: vi.fn(async () => [{ _id: "c1", type: "group" }]),
    };
    conversationFind.mockReturnValue(chain);
    groupFind.mockReturnValue({ lean: vi.fn(async () => [{ conversationId: "c1", name: "Grupo" }]) });

    const result = await listConversations("u1", { limit: 10, offset: 20 });

    expect(chain.sort).toHaveBeenCalledWith({ updatedAt: -1, _id: 1 });
    expect(chain.skip).toHaveBeenCalledWith(20);
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(result).toEqual([{ _id: "c1", type: "group", group: { conversationId: "c1", name: "Grupo" } }]);
  });
});

describe("[Regressão] deleteConversation", () => {
  it("apaga mídia, membros, grupo e por último a conversa", async () => {
    await deleteConversation("c1");

    const { deleteConversationMedia } = await import("../../src/modules/messages/message.service");
    expect(deleteConversationMedia).toHaveBeenCalledWith("c1");
    expect(memberDeleteMany).toHaveBeenCalledWith({ conversationId: "c1" });
    expect(groupDeleteOne).toHaveBeenCalledWith({ conversationId: "c1" });
    expect(conversationDeleteOne).toHaveBeenCalledWith({ _id: "c1" });
  });
});
