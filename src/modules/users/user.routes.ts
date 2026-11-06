import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import { paginationSchema, userIdSchema } from "../../shared/schemas";
import { ConversationMemberModel } from "../conversations/conversation-member.model";
import { UserModel } from "./user.model";

const idParams = z.object({ id: userIdSchema });

function assertAdmin(req: FastifyRequest) {
  if (!req.user.isAdmin) throw new HttpError(403, "forbidden");
}

function assertSelfOrAdmin(req: FastifyRequest, id: string) {
  if (id !== req.user.id && !req.user.isAdmin) throw new HttpError(403, "forbidden");
}

function ensureUser(keycloakId: string) {
  return UserModel.findOneAndUpdate(
    { keycloakId },
    { $setOnInsert: { keycloakId } },
    { upsert: true, returnDocument: "after" },
  );
}

// Não há PATCH: o único campo é o id do Keycloak, que não muda
const userRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  app.get("/users/me", async (req) => ensureUser(req.user.id));

  app.get("/users", async (req) => {
    assertAdmin(req);
    const { limit, offset } = paginationSchema.parse(req.query);
    return UserModel.find().sort({ _id: 1 }).skip(offset).limit(limit).lean();
  });

  app.post("/users", async (req) => {
    assertAdmin(req);
    const { keycloakId } = z.object({ keycloakId: userIdSchema }).parse(req.body);
    return ensureUser(keycloakId);
  });

  app.get("/users/:id", async (req) => {
    const { id } = idParams.parse(req.params);
    assertSelfOrAdmin(req, id);
    const user = await UserModel.findOne({ keycloakId: id }).lean();
    if (!user) throw new HttpError(404, "user_not_found");
    return user;
  });

  app.delete("/users/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    assertSelfOrAdmin(req, id);
    await ConversationMemberModel.deleteMany({ userId: id });
    await UserModel.deleteOne({ keycloakId: id });
    return reply.code(204).send();
  });
};

export default userRoutes;
