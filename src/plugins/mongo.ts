import fp from "fastify-plugin";
import mongoose from "mongoose";

export default fp(async (app) => {
  await mongoose.connect(Bun.env.MONGODB_URI!);

  app.addHook("onClose", async () => {
    await mongoose.disconnect();
  });
});
