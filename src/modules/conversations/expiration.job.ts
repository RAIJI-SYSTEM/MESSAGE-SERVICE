import type { FastifyBaseLogger } from "fastify";
import { ConversationModel } from "./conversation.model";
import { deleteConversation } from "./conversation.service";

const INTERVAL_MS = 60_000;
const BATCH_SIZE = 100;

export async function purgeExpiredConversations(log: FastifyBaseLogger) {
  const expired = await ConversationModel.find({ expiresAt: { $lte: new Date() } }, "rideId expiresAt")
    .limit(BATCH_SIZE)
    .lean();

  for (const conversation of expired) {
    await deleteConversation(conversation._id);
    log.info(
      { conversationId: conversation._id, rideId: conversation.rideId, expiresAt: conversation.expiresAt },
      "conversa expirada removida",
    );
  }
  return expired.length;
}

/** Com várias instâncias a remoção pode rodar em paralelo, mas repeti-la não causa problema. */
export function startExpirationJob(log: FastifyBaseLogger) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await purgeExpiredConversations(log);
    } catch (err) {
      log.error({ err }, "falha ao remover conversas expiradas");
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
