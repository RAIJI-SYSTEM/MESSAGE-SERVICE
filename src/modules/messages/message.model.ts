import { Schema, model, type InferSchemaType } from "mongoose";
import { attachmentFields } from "./attachment.model";

/** O _id do anexo é o mesmo do upload pendente que o originou (e o fim da chave no S3) */
const messageAttachmentSchema = new Schema(attachmentFields);

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    senderId: { type: String, required: true }, // keycloakId
    text: { type: String, default: "" },
    attachments: { type: [messageAttachmentSchema], default: [] },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });

export type Message = InferSchemaType<typeof messageSchema>;
export const MessageModel = model("Message", messageSchema);
