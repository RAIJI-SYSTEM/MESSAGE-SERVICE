import { Schema, model, type InferSchemaType } from "mongoose";

const conversationMemberSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
  userId: { type: String, required: true }, // keycloakId
  joinedAt: { type: Date, default: Date.now, required: true },
  // Nome informado por quem abriu a conversa; vale até a pessoa usar o chat (aí vale o do token dela)
  name: { type: String, default: null },
  // Papel na conversa: motorista, passageiro ou empresa (o app usa para títulos e filtros)
  role: { type: String, enum: ["driver", "passenger", "company", null], default: null },
  // Até quando a pessoa leu: o que chegou depois (de outra pessoa) conta como não lido
  lastReadAt: { type: Date, default: null },
});

conversationMemberSchema.index({ conversationId: 1, userId: 1 }, { unique: true });
conversationMemberSchema.index({ userId: 1 });

export type ConversationMember = InferSchemaType<typeof conversationMemberSchema>;
export const ConversationMemberModel = model("ConversationMember", conversationMemberSchema);
