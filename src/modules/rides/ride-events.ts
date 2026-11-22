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
  // Foto completa da carona, enviada pelo backend a cada mudança (ver syncRide)
  z.object({
    type: z.literal("ride.synced"),
    rideId,
    driverId: userIdSchema,
    driverName: z.string().max(200).nullish(),
    name: z.string().trim().min(1).max(100),
    origin: z.string().max(200),
    destination: z.string().max(200),
    status: z.enum(["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
    occurredAt: timestamp,
    passengers: z.array(z.object({ userId: userIdSchema, name: z.string().max(200).nullish() })).max(100),
  }),
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
    case "ride.synced":
      return syncRide(event);
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

type RideSynced = Extract<RideEvent, { type: "ride.synced" }>;

/**
 * Deixa o grupo igual à carona: motorista + passageiros aceitos, com nomes e papéis.
 * - Sem passageiros e sem grupo ainda: não cria (motorista sozinho não precisa de grupo).
 * - Quem saiu da lista sai do grupo (cancelou a reserva).
 * - Carona concluída ou cancelada: o grupo some 3 dias depois.
 */
async function syncRide(event: RideSynced) {
  const existing = await ConversationModel.findOne({ rideId: event.rideId });
  if (!existing && event.passengers.length === 0) return;

  const ended = event.status === "COMPLETED" || event.status === "CANCELLED";
  const context = {
    kind: "ride" as const,
    refId: event.rideId,
    label: "Grupo da viagem",
    origin: event.origin,
    destination: event.destination,
    subId: null,
  };
  const conversation = await ConversationModel.findOneAndUpdate(
    { rideId: event.rideId },
    {
      $setOnInsert: { type: "group" },
      $set: {
        context,
        expiresAt: ended ? new Date(Date.parse(event.occurredAt) + RETENTION_AFTER_RIDE_MS) : null,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  await GroupModel.updateOne(
    { conversationId: conversation._id },
    { $set: { name: event.name }, $setOnInsert: { createdBy: event.driverId } },
    { upsert: true },
  );

  const members = [
    { userId: event.driverId, name: event.driverName ?? null, role: "driver" as const },
    ...event.passengers
      .filter((p) => p.userId !== event.driverId)
      .map((p) => ({ userId: p.userId, name: p.name ?? null, role: "passenger" as const })),
  ];
  await ConversationMemberModel.bulkWrite(
    members.map((m) => ({
      updateOne: {
        filter: { conversationId: conversation._id, userId: m.userId },
        update: {
          $set: { role: m.role, ...(m.name ? { name: m.name } : {}) },
          $setOnInsert: { joinedAt: new Date() },
        },
        upsert: true,
      },
    })),
  );
  await ConversationMemberModel.deleteMany({
    conversationId: conversation._id,
    userId: { $nin: members.map((m) => m.userId) },
  });
}
