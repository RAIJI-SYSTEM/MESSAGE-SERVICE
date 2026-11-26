import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationMemberModel } from "../../src/modules/conversations/conversation-member.model";
import { ConversationModel } from "../../src/modules/conversations/conversation.model";
import { GroupModel } from "../../src/modules/conversations/group.model";
import { deleteUserCascade, ensureUser, rememberName } from "../../src/modules/users/user.service";
import { UserModel } from "../../src/modules/users/user.model";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

describe("rememberName", () => {
  it("não grava quando o token não traz nome", async () => {
    await rememberName("u-null", null);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it("grava o nome do token e ignora repetições iguais", async () => {
    const spy = vi.spyOn(UserModel, "updateOne");
    await rememberName("u-1", "Ana Souza");
    await rememberName("u-1", "Ana Souza");

    expect(spy).toHaveBeenCalledTimes(1);
    expect((await UserModel.findOne({ keycloakId: "u-1" }).lean())?.name).toBe("Ana Souza");
  });

  it("atualiza quando o nome muda", async () => {
    await rememberName("u-2", "Ana");
    await rememberName("u-2", "Ana Souza");
    expect((await UserModel.findOne({ keycloakId: "u-2" }).lean())?.name).toBe("Ana Souza");
  });
});

describe("ensureUser", () => {
  it("cria uma única vez", async () => {
    const first = await ensureUser("u-3");
    const second = await ensureUser("u-3");
    expect(String(first!._id)).toBe(String(second!._id));
    expect(await UserModel.countDocuments()).toBe(1);
  });
});

describe("deleteUserCascade", () => {
  it("não falha quando o usuário não existe (reentrega de evento)", async () => {
    await expect(deleteUserCascade("u-inexistente")).resolves.toEqual({ deletedConversations: 0 });
  });

  it("remove grupos criados, conversas diretas e participações", async () => {
    await ensureUser("u-dono");
    await ensureUser("u-outro");

    // grupo criado pelo usuário (dono) + grupo do qual só participa
    const owned = await ConversationModel.create({ type: "group" });
    await GroupModel.create({ conversationId: owned._id, name: "Meu grupo", createdBy: "u-dono" });
    await ConversationMemberModel.create({ conversationId: owned._id, userId: "u-dono" });

    const other = await ConversationModel.create({ type: "group" });
    await GroupModel.create({ conversationId: other._id, name: "Grupo alheio", createdBy: "u-outro" });
    await ConversationMemberModel.create({ conversationId: other._id, userId: "u-outro" });
    await ConversationMemberModel.create({ conversationId: other._id, userId: "u-dono" });

    const direct = await ConversationModel.create({ type: "direct", directKey: "u-dono:u-outro" });
    await ConversationMemberModel.create({ conversationId: direct._id, userId: "u-dono" });
    await ConversationMemberModel.create({ conversationId: direct._id, userId: "u-outro" });

    const result = await deleteUserCascade("u-dono");

    expect(result.deletedConversations).toBe(2);
    expect(await ConversationModel.findById(owned._id)).toBeNull();
    expect(await ConversationModel.findById(direct._id)).toBeNull();
    expect(await ConversationModel.findById(other._id)).not.toBeNull();
    expect(await GroupModel.findOne({ conversationId: other._id })).not.toBeNull();
    expect(await ConversationMemberModel.countDocuments({ userId: "u-dono" })).toBe(0);
    expect(await UserModel.findOne({ keycloakId: "u-dono" })).toBeNull();
    expect(await UserModel.findOne({ keycloakId: "u-outro" })).not.toBeNull();
  });
});
