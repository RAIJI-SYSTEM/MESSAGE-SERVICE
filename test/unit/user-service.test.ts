import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Regressão] user.service.
 *
 * O chat é idempotente por natureza: eventos repetidos do Keycloak não podem
 * duplicar usuário nem conversa. O teste fixa upserts, cache de nome e cascata.
 */
const userUpdateOne = vi.hoisted(() => vi.fn());
const userFindOneAndUpdate = vi.hoisted(() => vi.fn());
const userDeleteOne = vi.hoisted(() => vi.fn());
const memberFind = vi.hoisted(() => vi.fn());
const memberDeleteMany = vi.hoisted(() => vi.fn());
const conversationFind = vi.hoisted(() => vi.fn());
const groupFind = vi.hoisted(() => vi.fn());
const deleteConversation = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/users/user.model", () => ({
  UserModel: {
    updateOne: userUpdateOne,
    findOneAndUpdate: userFindOneAndUpdate,
    deleteOne: userDeleteOne,
  },
}));
vi.mock("../../src/modules/conversations/conversation-member.model", () => ({
  ConversationMemberModel: { find: memberFind, deleteMany: memberDeleteMany },
}));
vi.mock("../../src/modules/conversations/conversation.model", () => ({
  ConversationModel: { find: conversationFind },
}));
vi.mock("../../src/modules/conversations/group.model", () => ({
  GroupModel: { find: groupFind },
}));
vi.mock("../../src/modules/conversations/conversation.service", () => ({ deleteConversation }));

import {
  deleteUserCascade,
  ensureUser,
  rememberName,
} from "../../src/modules/users/user.service";

const lean = <T>(value: T) => ({ lean: vi.fn(async () => value) });
const distinct = <T>(value: T) => ({ distinct: vi.fn(async () => value) });

beforeEach(() => {
  vi.clearAllMocks();
  deleteConversation.mockResolvedValue(undefined);
});

describe("[Regressão] rememberName", () => {
  it("não grava sem nome", async () => {
    await rememberName("u-sem-nome", null);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  it("grava o nome uma vez e evita escrita repetida", async () => {
    userUpdateOne.mockResolvedValue({});

    await rememberName("u-cache", "Ana");
    await rememberName("u-cache", "Ana");

    expect(userUpdateOne).toHaveBeenCalledTimes(1);
    expect(userUpdateOne).toHaveBeenCalledWith(
      { keycloakId: "u-cache" },
      { $set: { name: "Ana" }, $setOnInsert: { keycloakId: "u-cache" } },
      { upsert: true },
    );
  });

  it("grava de novo quando o nome muda", async () => {
    userUpdateOne.mockResolvedValue({});

    await rememberName("u-muda", "Ana");
    await rememberName("u-muda", "Ana Souza");

    expect(userUpdateOne).toHaveBeenCalledTimes(2);
  });
});

describe("[Regressão] ensureUser", () => {
  it("faz upsert idempotente por keycloakId", async () => {
    const user = { keycloakId: "u1" };
    userFindOneAndUpdate.mockResolvedValue(user);

    await expect(ensureUser("u1")).resolves.toBe(user);
    expect(userFindOneAndUpdate).toHaveBeenCalledWith(
      { keycloakId: "u1" },
      { $setOnInsert: { keycloakId: "u1" } },
      { upsert: true, returnDocument: "after" },
    );
  });
});

describe("[Análise de Falhas] deleteUserCascade", () => {
  it("remove grupos próprios, conversas diretas e participações sem duplicar", async () => {
    groupFind.mockReturnValue(lean([{ conversationId: "c1" }, { conversationId: "c2" }]));
    memberFind.mockReturnValue(distinct(["c2", "c3"]));
    conversationFind.mockReturnValue(lean([{ _id: "c3" }]));

    const result = await deleteUserCascade("u1");

    expect(result).toEqual({ deletedConversations: 3 });
    expect(deleteConversation.mock.calls.map((c) => c[0]).sort()).toEqual(["c1", "c2", "c3"]);
    expect(memberDeleteMany).toHaveBeenCalledWith({ userId: "u1" });
    expect(userDeleteOne).toHaveBeenCalledWith({ keycloakId: "u1" });
  });

  it("usuário sem grupos/conversas é removido sem erro", async () => {
    groupFind.mockReturnValue(lean([]));
    memberFind.mockReturnValue(distinct([]));
    conversationFind.mockReturnValue(lean([]));

    await expect(deleteUserCascade("u2")).resolves.toEqual({ deletedConversations: 0 });
    expect(deleteConversation).not.toHaveBeenCalled();
  });
});
