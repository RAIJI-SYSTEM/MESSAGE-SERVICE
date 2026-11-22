import { ConversationMemberModel } from "../conversations/conversation-member.model";
import { ConversationModel } from "../conversations/conversation.model";
import { deleteConversation } from "../conversations/conversation.service";
import { GroupModel } from "../conversations/group.model";
import { UserModel } from "./user.model";

/** Último nome gravado de cada usuário: evita uma escrita no banco a cada requisição */
const knownNames = new Map<string, string>();

/** Guarda o nome do token do usuário (só grava quando muda). */
export async function rememberName(keycloakId: string, name: string | null) {
  if (!name || knownNames.get(keycloakId) === name) return;
  await UserModel.updateOne({ keycloakId }, { $set: { name }, $setOnInsert: { keycloakId } }, { upsert: true });
  knownNames.set(keycloakId, name);
}

/** Idempotente: cria o usuário só se ainda não existir. */
export function ensureUser(keycloakId: string) {
  return UserModel.findOneAndUpdate(
    { keycloakId },
    { $setOnInsert: { keycloakId } },
    { upsert: true, returnDocument: "after" },
  );
}

/**
 * Remove o usuário e tudo que só fazia sentido com ele:
 * - grupos que ele criou (inclui grupos de carona, cujo criador é o motorista);
 * - conversas diretas das quais participava;
 * - suas participações nos demais grupos.
 *
 * Idempotente: repetir (ex.: reentrega do evento) não causa erro.
 */
export async function deleteUserCascade(userId: string) {
  const ownedGroups = await GroupModel.find({ createdBy: userId }, "conversationId").lean();
  const memberOf = await ConversationMemberModel.find({ userId }).distinct("conversationId");
  const directs = await ConversationModel.find({ _id: { $in: memberOf }, type: "direct" }, "_id").lean();

  const conversationIds = new Set([
    ...ownedGroups.map((g) => String(g.conversationId)),
    ...directs.map((c) => String(c._id)),
  ]);
  for (const id of conversationIds) {
    await deleteConversation(id);
  }

  await ConversationMemberModel.deleteMany({ userId });
  await UserModel.deleteOne({ keycloakId: userId });
  return { deletedConversations: conversationIds.size };
}
