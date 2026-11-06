import { Schema, model, type InferSchemaType } from "mongoose";

const conversationMemberSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
  userId: { type: String, required: true }, // keycloakId
  joinedAt: { type: Date, default: Date.now, required: true },
});

conversationMemberSchema.index({ conversationId: 1, userId: 1 }, { unique: true });
conversationMemberSchema.index({ userId: 1 });

export type ConversationMember = InferSchemaType<typeof conversationMemberSchema>;
export const ConversationMemberModel = model("ConversationMember", conversationMemberSchema);
