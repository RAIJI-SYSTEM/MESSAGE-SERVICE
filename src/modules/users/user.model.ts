import { Schema, model, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    keycloakId: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema);
