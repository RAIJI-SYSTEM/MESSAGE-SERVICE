import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "../../shared/errors";
import { AuditEventModel } from "./audit.model";

const MAX_LIMIT = 500;

function limit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function date(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Consulta da auditoria do chat.
 * - GET /audit/me: últimas ações do próprio usuário;
 * - GET /audit/events: visão administrativa (role chat-admin).
 */
const auditRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  app.get("/audit/me", async (req) => {
    return AuditEventModel.find({ actorSub: req.user.id })
      .sort({ at: -1 })
      .limit(limit((req.query as { limit?: string }).limit))
      .lean();
  });

  app.get("/audit/events", async (req) => {
    if (!req.user.isAdmin) throw new HttpError(403, "forbidden");

    const query = req.query as {
      actorSub?: string;
      action?: string;
      from?: string;
      to?: string;
      limit?: string;
    };
    const filter: Record<string, unknown> = {};
    if (query.actorSub) filter.actorSub = query.actorSub;
    if (query.action) filter.action = query.action;
    const from = date(query.from);
    const to = date(query.to);
    if (from || to) {
      filter.at = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {}),
      };
    }

    return AuditEventModel.find(filter)
      .sort({ at: -1 })
      .limit(limit(query.limit))
      .lean();
  });
};

export default auditRoutes;
