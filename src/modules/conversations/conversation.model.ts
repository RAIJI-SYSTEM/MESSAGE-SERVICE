import { Schema, model, type InferSchemaType } from "mongoose";

const conversationSchema = new Schema(
  {
    type: { type: String, enum: ["direct", "group"], required: true },
    // Só em conversas diretas: impede duas conversas entre as mesmas pessoas
    directKey: { type: String, unique: true, sparse: true },
    // Só em grupos de carona: torna os eventos do sistema de caronas idempotentes
    rideId: { type: String, unique: true, sparse: true },
    // null = não expira. Em grupos de carona, é definido quando a carona termina
    expiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

export function buildDirectKey(userA: string, userB: string) {
  return [userA, userB].sort().join(":");
}

export type Conversation = InferSchemaType<typeof conversationSchema>;
export const ConversationModel = model("Conversation", conversationSchema);
