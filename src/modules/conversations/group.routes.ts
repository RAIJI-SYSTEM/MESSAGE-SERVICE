import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import { objectIdSchema, paginationSchema, userIdSchema } from "../../shared/schemas";
import { GroupModel } from "./group.model";
import {
  assertNotManagedByRide,
  createGroup,
  deleteConversation,
  listConversations,
  requireGroup,
} from "./conversation.service";

const idParams = z.object({ id: objectIdSchema });
const nameSchema = z.string().trim().min(1).max(100);

// O :id dos grupos é o id da conversa
const groupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  app.post("/groups", async (req, reply) => {
    const { name, memberIds } = z
      .object({ name: nameSchema, memberIds: z.array(userIdSchema).max(500).default([]) })
      .parse(req.body);
    const { conversation, group } = await createGroup(name, req.user.id, memberIds);
    return reply.code(201).send({ ...conversation.toObject(), group });
  });

  app.get("/groups", async (req) =>
    listConversations(req.user.id, paginationSchema.parse(req.query), "group"),
  );

  app.get("/groups/:id", async (req) => {
    const { id } = idParams.parse(req.params);
    const { conversation, group } = await requireGroup(id, req.user);
    return { ...conversation.toObject(), group };
  });

  app.patch("/groups/:id", async (req) => {
    const { id } = idParams.parse(req.params);
    const { name } = z.object({ name: nameSchema }).parse(req.body);
    const { canManage } = await requireGroup(id, req.user);
    if (!canManage) throw new HttpError(403, "forbidden");
    return GroupModel.findOneAndUpdate({ conversationId: id }, { name }, { returnDocument: "after" });
  });

  app.delete("/groups/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { conversation, canManage } = await requireGroup(id, req.user);
    if (!canManage) throw new HttpError(403, "forbidden");
    assertNotManagedByRide(conversation, req.user);
    await deleteConversation(id);
    return reply.code(204).send();
  });
};

export default groupRoutes;
