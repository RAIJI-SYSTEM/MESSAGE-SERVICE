import { z } from "zod";
import { ConversationMemberModel } from "../conversations/conversation-member.model";
import { ConversationModel } from "../conversations/conversation.model";
import { addMembers } from "../conversations/conversation.service";
import { GroupModel } from "../conversations/group.model";
import { userIdSchema } from "../../shared/schemas";

const RETENTION_AFTER_RIDE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_GROUP_NAME = "Carona";

const rideId = z.string().min(1).max(255);
const timestamp = z.iso.datetime({ offset: true });

export const rideEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ride.created"),
    rideId,
    driverId: userIdSchema,
    passengerIds: z.array(userIdSchema).default([]),
    name: z.string().trim().min(1).max(100).optional(),
  }),
  z.object({ type: z.literal("ride.participant_joined"), rideId, userId: userIdSchema }),
  z.object({ type: z.literal("ride.participant_left"), rideId, userId: userIdSchema }),
  z.object({ type: z.literal("ride.finished"), rideId, occurredAt: timestamp }),
  z.object({ type: z.literal("ride.cancelled"), rideId, occurredAt: timestamp }),
]);
export type RideEvent = z.infer<typeof rideEventSchema>;

/** O evento chegou antes do `ride.created`: o consumer deve devolvê-lo à fila para nova tentativa. */
export class RideNotFoundError extends Error {
  constructor(rideId: string) {
    super(`carona ${rideId} sem conversa`);
  }
}

async function requireRideConversation(id: string) {
  const conversation = await ConversationModel.findOne({ rideId: id });
  if (!conversation) throw new RideNotFoundError(id);
  return conversation;
}

/**
 * Ponto de entrada do consumer da mensageria. Todo evento é idempotente, então
 * pode ser reprocessado. Payload inválido lança ZodError (não adianta repetir).
 */
export async function handleRideEvent(raw: unknown) {
  const event = rideEventSchema.parse(raw);

  switch (event.type) {
    case "ride.created": {
      const conversation = await ConversationModel.findOneAndUpdate(
        { rideId: event.rideId },
        { $setOnInsert: { type: "group" } },
        { upsert: true, returnDocument: "after" },
      );
      await GroupModel.updateOne(
        { conversationId: conversation._id },
        { $setOnInsert: { name: event.name ?? DEFAULT_GROUP_NAME, createdBy: event.driverId } },
        { upsert: true },
      );
      await addMembers(conversation._id, [event.driverId, ...event.passengerIds]);
      return;
    }
    case "ride.participant_joined": {
      const conversation = await requireRideConversation(event.rideId);
      await addMembers(conversation._id, [event.userId]);
      return;
    }
    case "ride.participant_left": {
      const conversation = await requireRideConversation(event.rideId);
      await ConversationMemberModel.deleteOne({ conversationId: conversation._id, userId: event.userId });
      return;
    }
    case "ride.finished":
    case "ride.cancelled": {
      const expiresAt = new Date(Date.parse(event.occurredAt) + RETENTION_AFTER_RIDE_MS);
      const { matchedCount } = await ConversationModel.updateOne({ rideId: event.rideId }, { expiresAt });
      // Sem conversa e já vencida: é reentrega de um grupo que o job já removeu
      if (!matchedCount && expiresAt > new Date()) throw new RideNotFoundError(event.rideId);
      return;
    }
  }
}
