import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import { objectIdSchema, paginationSchema, userIdSchema } from "../../shared/schemas";
import { ConversationMemberModel } from "./conversation-member.model";
import { ConversationModel } from "./conversation.model";
import { GroupModel } from "./group.model";
import {
  addMembers,
  assertNotManagedByRide,
  deleteConversation,
  findOrCreateDirect,
  listConversations,
  requireConversation,
  requireGroup,
} from "./conversation.service";

const idParams = z.object({ id: objectIdSchema });
const memberParams = idParams.extend({ userId: userIdSchema });

const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  app.post("/conversations/direct", async (req) => {
    const { userId } = z.object({ userId: userIdSchema }).parse(req.body);
    if (userId === req.user.id) throw new HttpError(400, "invalid_recipient");
    return findOrCreateDirect(req.user.id, userId);
  });

  app.get("/conversations", async (req) =>
    listConversations(req.user.id, paginationSchema.parse(req.query)),
  );

  app.get("/conversations/:id", async (req) => {
    const { id } = idParams.parse(req.params);
    const conversation = await requireConversation(id, req.user);
    const group = await GroupModel.findOne({ conversationId: id }).lean();
    return { ...conversation.toObject(), group };
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
