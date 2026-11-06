import { Schema, model, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    keycloakId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    email: String,
    displayName: String,
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema);
