import { z } from "zod";

export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i);
export const userIdSchema = z.string().min(1).max(255);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
