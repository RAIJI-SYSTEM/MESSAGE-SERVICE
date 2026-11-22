import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { objectIdSchema } from "../../shared/schemas";
import { markRead, requireConversation } from "../conversations/conversation.service";
import { rememberName } from "../users/user.service";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_TEXT_LENGTH } from "./attachment-rules";
import { CHAT_EXCHANGE } from "../../plugins/rabbitmq";
import { messageCreatedEvent } from "./message-events";
import { createUpload, listMessages, sendMessage } from "./message.service";

const idParams = z.object({ id: objectIdSchema });

const uploadBody = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(127),
  sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  durationSeconds: z.number().nonnegative().optional(),
});

const messageBody = z.object({
  text: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  attachmentIds: z.array(objectIdSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Envio de mídia em 3 passos (os bytes nunca passam pelo chat):
 *   1. POST /conversations/:id/attachments  -> { attachment, upload: { url, fields } }
 *   2. o app faz POST multipart direto em upload.url (campos + "file" por último)
 *   3. POST /conversations/:id/messages     -> { text?, attachmentIds: [attachment.id] }
 */
const messageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", async (req) => rememberName(req.user.id, req.user.name));

  app.post("/conversations/:id/attachments", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = uploadBody.parse(req.body);
    await requireConversation(id, req.user);
    return reply.code(201).send(await createUpload(id, req.user.id, body));
  });

  app.post("/conversations/:id/messages", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = messageBody.parse(req.body);
    await requireConversation(id, req.user);
    const sent = await sendMessage(id, req.user.id, body);
    // Push para os outros membros (pelo backend); falhar aqui nunca impede a mensagem
    messageCreatedEvent(id, req.user, sent)
      .then((event) => event && app.publishEvent(CHAT_EXCHANGE, "message.created", event))
      .catch((err) => req.log.warn({ err }, "evento de mensagem nova não publicado"));
    return reply.code(201).send(sent);
  });

  app.get("/conversations/:id/messages", async (req) => {
    const { id } = idParams.parse(req.params);
    const { limit, before } = listQuery.parse(req.query);
    await requireConversation(id, req.user);
    // Ler as mensagens mais recentes = conversa lida
    if (!before) await markRead(id, req.user.id);
    return listMessages(id, { limit, before: before ? new Date(before) : undefined });
  });
};

export default messageRoutes;
