import type { Types } from "mongoose";
import type { AuthUser } from "../../plugins/auth";
import { HttpError } from "../../shared/errors";
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
