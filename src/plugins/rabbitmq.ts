import amqp, { type ChannelModel, type ConsumeMessage } from "amqplib";
import fp from "fastify-plugin";
import { z } from "zod";
import { handleUserEvent } from "../modules/users/user-events";

const EXCHANGE = Bun.env.RABBITMQ_USERS_EXCHANGE || "raiji.users";
const QUEUE = "chat.user-events";
const DEAD_LETTER_EXCHANGE = `${EXCHANGE}.dlx`;
const DEAD_LETTER_QUEUE = `${QUEUE}.dlq`;
const RETRY_DELAY_MS = 5_000;

/**
 * Consome eventos de ciclo de vida do usuário (Keycloak -> RabbitMQ -> chat).
 *
 * - Reconexão automática do amqplib (`recovery`); o `setup` recria a topologia
 *   e o consumer a cada conexão.
 * - Não bloqueia a subida do chat: sem broker, a API continua no ar.
 * - Payload inválido vai para a DLQ `chat.user-events.dlq`; falha temporária
 *   (ex.: Mongo fora do ar) devolve a mensagem à fila após um intervalo.
 */
export default fp(async (app) => {
  const uri = Bun.env.RABBITMQ_URI;
  if (!uri) {
    app.log.warn("RABBITMQ_URI não definido: sincronização de usuários desativada");
    return;
  }

  async function setup(model: ChannelModel) {
    const channel = await model.createChannel();
    await channel.assertExchange(EXCHANGE, "topic", { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, "fanout", { durable: true });
    await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, "");
    await channel.assertQueue(QUEUE, { durable: true, deadLetterExchange: DEAD_LETTER_EXCHANGE });
    await channel.bindQueue(QUEUE, EXCHANGE, "user.*");
    await channel.prefetch(10);

    await channel.consume(QUEUE, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        await handleUserEvent(JSON.parse(msg.content.toString()), app.log);
        channel.ack(msg);
      } catch (err) {
        if (err instanceof SyntaxError || err instanceof z.ZodError) {
          app.log.warn({ err, routingKey: msg.fields.routingKey }, "evento de usuário inválido: enviado à DLQ");
          channel.nack(msg, false, false);
          return;
        }
        app.log.error({ err }, "falha ao processar evento de usuário: nova tentativa em breve");
        setTimeout(() => {
          try {
            channel.nack(msg, false, true);
          } catch {
            // canal fechado: o broker reentrega a mensagem não confirmada sozinho
          }
        }, RETRY_DELAY_MS);
      }
    });
    app.log.info({ queue: QUEUE, exchange: EXCHANGE }, "rabbitmq: consumindo eventos de usuário");
  }

  const connection = await amqp.connect(uri, {
    clientProperties: { connection_name: "raiji-chat" },
    recovery: { initialDelay: 500, maxDelay: 15_000, waitForConnect: false, setup },
  });
  connection.on("disconnect", (err) => app.log.warn({ err }, "rabbitmq: desconectado, reconectando"));
  connection.on("reconnect-scheduled", ({ attempt, delay }) =>
    app.log.info({ attempt, delay }, "rabbitmq: nova tentativa de conexão agendada"),
  );
  connection.on("error", (err) => app.log.error({ err }, "rabbitmq: erro"));

  app.addHook("onClose", async () => {
    await connection.close().catch(() => {});
  });
});
