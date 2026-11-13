import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { userIdSchema } from "../../shared/schemas";
import { deleteUserCascade, ensureUser } from "./user.service";

/**
 * Eventos publicados pelo plugin "raiji-rabbitmq" do Keycloak
 * (exchange topic `raiji.users`, routing key = type).
 * Campos extras (realm, occurredAt) são ignorados.
 */
export const userEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user.created"), userId: userIdSchema }),
  z.object({ type: z.literal("user.deleted"), userId: userIdSchema }),
]);
export type UserEvent = z.infer<typeof userEventSchema>;

/** Todo evento é idempotente. Payload inválido lança ZodError (vai para a DLQ). */
export async function handleUserEvent(raw: unknown, log: FastifyBaseLogger) {
  const event = userEventSchema.parse(raw);

  switch (event.type) {
    case "user.created":
      await ensureUser(event.userId);
      log.info({ userId: event.userId }, "usuário criado a partir do Keycloak");
      return;
    case "user.deleted": {
      const { deletedConversations } = await deleteUserCascade(event.userId);
      log.info({ userId: event.userId, deletedConversations }, "usuário removido a partir do Keycloak");
      return;
    }
  }
}
