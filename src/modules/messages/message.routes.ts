import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { objectIdSchema } from "../../shared/schemas";
import { requireConversation } from "../conversations/conversation.service";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_TEXT_LENGTH } from "./attachment-rules";
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
    return reply.code(201).send(await sendMessage(id, req.user.id, body));
  });

  app.get("/conversations/:id/messages", async (req) => {
    const { id } = idParams.parse(req.params);
    const { limit, before } = listQuery.parse(req.query);
    await requireConversation(id, req.user);
    return listMessages(id, { limit, before: before ? new Date(before) : undefined });
  });
};

export default messageRoutes;
