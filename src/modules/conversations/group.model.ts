import { Schema, model, type InferSchemaType } from "mongoose";

const groupSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, unique: true },
    name: { type: String, required: true, trim: true },
    createdBy: { type: String, required: true }, // keycloakId
  },
  { timestamps: true },
);

export type Group = InferSchemaType<typeof groupSchema>;
export const GroupModel = model("Group", groupSchema);
