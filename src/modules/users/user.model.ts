import { Schema, model, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    keycloakId: { type: String, required: true, unique: true },
    // Nome de exibição, do próprio token do usuário (claim "name")
    name: { type: String, default: null },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema);
