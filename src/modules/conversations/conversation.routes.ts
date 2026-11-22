import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import { objectIdSchema, paginationSchema, userIdSchema } from "../../shared/schemas";
import { ConversationMemberModel } from "./conversation-member.model";
import { ConversationModel } from "./conversation.model";
import { GroupModel } from "./group.model";
import { rememberName } from "../users/user.service";
import {
  addMembers,
  assertNotManagedByRide,
  deleteConversation,
  describeConversations,
  listConversations,
  markRead,
  openDirect,
  requireConversation,
  requireGroup,
} from "./conversation.service";

const idParams = z.object({ id: objectIdSchema });
const memberParams = idParams.extend({ userId: userIdSchema });
const roleSchema = z.enum(["driver", "passenger", "company"]);
const directBody = z.object({
  userId: userIdSchema,
  name: z.string().trim().min(1).max(150).optional(),
  role: roleSchema.optional(),
  myRole: roleSchema.optional(),
  context: z
    .object({
      kind: z.enum(["ride", "delivery"]),
      refId: z.string().min(1).max(64),
      label: z.string().trim().min(1).max(80),
      origin: z.string().trim().min(1).max(200),
      destination: z.string().trim().min(1).max(200),
      subId: z.string().min(1).max(64).nullish(),
    })
    .optional(),
});

const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  // O nome que aparece para os outros vem do token de cada um
  app.addHook("preHandler", async (req) => rememberName(req.user.id, req.user.name));

  /** Abre a conversa direta (ex.: passageiro -> motorista de uma carona) */
  app.post("/conversations/direct", async (req) => {
    const body = directBody.parse(req.body);
    if (body.userId === req.user.id) throw new HttpError(400, "invalid_recipient");
    const conversation = await openDirect(req.user, body);
    const fresh = await ConversationModel.findById(conversation._id).lean();
    const [described] = await describeConversations([fresh!], req.user.id);
    return { ...described, group: null };
  });

  app.get("/conversations", async (req) =>
    describeConversations(await listConversations(req.user.id, paginationSchema.parse(req.query)), req.user.id),
  );

  app.get("/conversations/:id", async (req) => {
    const { id } = idParams.parse(req.params);
    const conversation = await requireConversation(id, req.user);
    const group = await GroupModel.findOne({ conversationId: id }).lean();
    const [described] = await describeConversations([conversation.toObject()], req.user.id);
    return { ...described, group };
  });

  /** Grupo da carona (motorista + passageiros aceitos). 404 se ainda não existe ou se não participa. */
  app.get("/conversations/by-ride/:rideId", async (req) => {
    const { rideId } = z.object({ rideId: z.string().min(1).max(64) }).parse(req.params);
    const found = await ConversationModel.findOne({ rideId }, "_id").lean();
    if (!found) throw new HttpError(404, "ride_group_not_found");
    const conversation = await requireConversation(String(found._id), req.user);
    const [described] = await describeConversations([conversation.toObject()], req.user.id);
    return described;
  });

  /** Marca a conversa como lida até agora */
  app.post("/conversations/:id/read", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await requireConversation(id, req.user);
    await markRead(id, req.user.id);
    return reply.code(204).send();
  });

  // Só para correções manuais: em caronas, a data vem do evento de término
  app.patch("/conversations/:id", async (req) => {
    if (!req.user.isAdmin) throw new HttpError(403, "forbidden");
    const { id } = idParams.parse(req.params);
    const { expiresAt } = z
      .object({ expiresAt: z.iso.datetime({ offset: true }).nullable() })
      .parse(req.body);
    await requireConversation(id, req.user);
    return ConversationModel.findByIdAndUpdate(
      id,
      { expiresAt: expiresAt && new Date(expiresAt) },
      { returnDocument: "after" },
    );
  });

  app.delete("/conversations/:id", async (req, reply) => {
    if (!req.user.isAdmin) throw new HttpError(403, "forbidden");
    const { id } = idParams.parse(req.params);
    await requireConversation(id, req.user);
    await deleteConversation(id);
    return reply.code(204).send();
  });

  app.get("/conversations/:id/members", async (req) => {
    const { id } = idParams.parse(req.params);
    await requireConversation(id, req.user);
    const { limit, offset } = paginationSchema.parse(req.query);
    return ConversationMemberModel.find({ conversationId: id })
      .sort({ joinedAt: 1, _id: 1 })
      .skip(offset)
      .limit(limit)
      .lean();
  });

  app.post("/conversations/:id/members", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { userId } = z.object({ userId: userIdSchema }).parse(req.body);
    const { conversation, canManage } = await requireGroup(id, req.user);
    if (!canManage) throw new HttpError(403, "forbidden");
    assertNotManagedByRide(conversation, req.user);
    await addMembers(id, [userId]);
    return reply.code(204).send();
  });

  app.delete("/conversations/:id/members/:userId", async (req, reply) => {
    const { id, userId } = memberParams.parse(req.params);
    const { conversation, group, canManage } = await requireGroup(id, req.user);
    assertNotManagedByRide(conversation, req.user);
    if (userId !== req.user.id && !canManage) throw new HttpError(403, "forbidden");
    if (userId === group.createdBy && !req.user.isAdmin) {
      throw new HttpError(409, "cannot_remove_creator");
    }

    const { deletedCount } = await ConversationMemberModel.deleteOne({ conversationId: id, userId });
    if (!deletedCount) throw new HttpError(404, "member_not_found");
    return reply.code(204).send();
  });
};

export default conversationRoutes;
