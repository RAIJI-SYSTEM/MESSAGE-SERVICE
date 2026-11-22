import type { Types } from "mongoose";
import type { AuthUser } from "../../plugins/auth";
import { HttpError } from "../../shared/errors";
import { MessageModel } from "../messages/message.model";
import { deleteConversationMedia, toPreviewDto } from "../messages/message.service";
import { UserModel } from "../users/user.model";
import { ConversationMemberModel } from "./conversation-member.model";
import { ConversationModel, buildDirectKey } from "./conversation.model";
import { GroupModel } from "./group.model";

type Id = string | Types.ObjectId;

const activeFilter = () => ({
  $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
});

/** Idempotente: quem já é membro não é alterado. */
export async function addMembers(conversationId: Id, userIds: string[]) {
  if (!userIds.length) return;
  await ConversationMemberModel.bulkWrite(
    [...new Set(userIds)].map((userId) => ({
      updateOne: {
        filter: { conversationId, userId },
        update: { $setOnInsert: { joinedAt: new Date() } },
        upsert: true,
      },
    })),
  );
}

export async function findOrCreateDirect(userA: string, userB: string) {
  const directKey = buildDirectKey(userA, userB);
  const conversation = await ConversationModel.findOneAndUpdate(
    { directKey },
    { $setOnInsert: { type: "direct" } },
    { upsert: true, returnDocument: "after" },
  );
  await addMembers(conversation._id, [userA, userB]);
  return conversation;
}

export async function createGroup(name: string, createdBy: string, memberIds: string[]) {
  const conversation = await ConversationModel.create({ type: "group" });
  try {
    const group = await GroupModel.create({ conversationId: conversation._id, name, createdBy });
    await addMembers(conversation._id, [createdBy, ...memberIds]);
    return { conversation, group };
  } catch (err) {
    await deleteConversation(conversation._id);
    throw err;
  }
}

/** O documento da conversa sai por último: se falhar no meio, dá para repetir. */
export async function deleteConversation(conversationId: Id) {
  await deleteConversationMedia(conversationId); // mensagens, anexos e arquivos no S3
  await ConversationMemberModel.deleteMany({ conversationId });
  await GroupModel.deleteOne({ conversationId });
  await ConversationModel.deleteOne({ _id: conversationId });
}

/** Responde 404 para quem não participa, para não revelar que a conversa existe. */
export async function requireConversation(id: string, user: AuthUser) {
  const conversation = await ConversationModel.findOne(
    user.isAdmin ? { _id: id } : { _id: id, ...activeFilter() },
  );
  if (!conversation) throw new HttpError(404, "conversation_not_found");

  if (!user.isAdmin) {
    const member = await ConversationMemberModel.exists({ conversationId: id, userId: user.id });
    if (!member) throw new HttpError(404, "conversation_not_found");
  }
  return conversation;
}

export async function requireGroup(id: string, user: AuthUser) {
  const conversation = await requireConversation(id, user);
  const group = await GroupModel.findOne({ conversationId: id });
  if (conversation.type !== "group" || !group) throw new HttpError(404, "group_not_found");
  return { conversation, group, canManage: user.isAdmin || group.createdBy === user.id };
}

/** Em grupos de carona, os membros são definidos pelo sistema de caronas. */
export function assertNotManagedByRide(conversation: { rideId?: string | null }, user: AuthUser) {
  if (conversation.rideId && !user.isAdmin) throw new HttpError(409, "managed_by_ride");
}

export async function listConversations(
  userId: string,
  { limit, offset }: { limit: number; offset: number },
  type?: "direct" | "group",
) {
  const ids = await ConversationMemberModel.find({ userId }).distinct("conversationId");
  const conversations = await ConversationModel.find({
    _id: { $in: ids },
    ...activeFilter(),
    ...(type && { type }),
  })
    .sort({ updatedAt: -1, _id: 1 })
    .skip(offset)
    .limit(limit)
    .lean();

  const groups = await GroupModel.find({
    conversationId: { $in: conversations.map((c) => c._id) },
  }).lean();
  const byConversation = new Map(groups.map((g) => [String(g.conversationId), g]));
  return conversations.map((c) => ({ ...c, group: byConversation.get(String(c._id)) ?? null }));
}

// ---------------------------------------------------------------------------
// Conversa direta aberta pelo app (ex.: "Mandar mensagem" ao motorista de uma carona)
// ---------------------------------------------------------------------------

export type MemberRole = "driver" | "passenger" | "company";

export interface ConversationContext {
  kind: "ride" | "delivery";
  refId: string;
  label: string;
  origin: string;
  destination: string;
  subId?: string | null;
}

export interface OpenDirectRequest {
  userId: string;
  /** Nome de quem vai receber, como o app conhece (vale até a pessoa usar o chat) */
  name?: string;
  role?: MemberRole;
  myRole?: MemberRole;
  context?: ConversationContext;
}

/** Abre (ou reabre) a conversa direta e atualiza papéis, nomes e o assunto (corrida/encomenda). */
export async function openDirect(me: AuthUser, request: OpenDirectRequest) {
  const conversation = await findOrCreateDirect(me.id, request.userId);
  const updates: Promise<unknown>[] = [];
  if (request.name || request.role) {
    updates.push(
      ConversationMemberModel.updateOne(
        { conversationId: conversation._id, userId: request.userId },
        { $set: { ...(request.name && { name: request.name }), ...(request.role && { role: request.role }) } },
      ),
    );
  }
  updates.push(
    ConversationMemberModel.updateOne(
      { conversationId: conversation._id, userId: me.id },
      { $set: { ...(me.name && { name: me.name }), ...(request.myRole && { role: request.myRole }) } },
    ),
  );
  if (request.context) {
    updates.push(ConversationModel.updateOne({ _id: conversation._id }, { $set: { context: request.context } }));
  }
  await Promise.all(updates);
  return conversation;
}

/** Marca como lido até agora (abrir a conversa) */
export async function markRead(conversationId: Id, userId: string) {
  await ConversationMemberModel.updateOne({ conversationId, userId }, { $set: { lastReadAt: new Date() } });
}

/**
 * Formato da conversa para o app: membros com nome e papel, última mensagem e não lidas.
 * O nome do próprio usuário (do token dele) tem prioridade sobre o informado por quem abriu a conversa.
 */
export async function describeConversations<T extends { _id: Types.ObjectId }>(conversations: T[], userId: string) {
  if (!conversations.length) return [];
  const ids = conversations.map((c) => c._id);
  const members = await ConversationMemberModel.find({ conversationId: { $in: ids } }).lean();
  const users = await UserModel.find({ keycloakId: { $in: [...new Set(members.map((m) => m.userId))] } }, "keycloakId name").lean();
  const nameOf = new Map(users.map((u) => [u.keycloakId, u.name ?? null]));
  const groups = await GroupModel.find({ conversationId: { $in: ids } }, "conversationId name").lean();
  const groupOf = new Map(groups.map((g) => [String(g.conversationId), { name: g.name }]));

  return Promise.all(
    conversations.map(async (c) => {
      const mine = members.filter((m) => String(m.conversationId) === String(c._id));
      const me = mine.find((m) => m.userId === userId);
      const [last, unreadCount] = await Promise.all([
        MessageModel.findOne({ conversationId: c._id }).sort({ createdAt: -1, _id: -1 }).lean(),
        MessageModel.countDocuments({
          conversationId: c._id,
          senderId: { $ne: userId },
          ...(me?.lastReadAt ? { createdAt: { $gt: me.lastReadAt } } : {}),
        }),
      ]);
      return {
        ...c,
        members: mine.map((m) => ({ userId: m.userId, name: nameOf.get(m.userId) ?? m.name ?? null, role: m.role ?? null })),
        lastMessage: last ? toPreviewDto(last) : null,
        unreadCount,
        group: groupOf.get(String(c._id)) ?? null,
      };
    }),
  );
}
