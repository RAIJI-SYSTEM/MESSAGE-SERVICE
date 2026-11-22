import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";
import type { FastifyBaseLogger } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { handleRideEvent, RideNotFoundError } from "../modules/rides/ride-events";
import { handleUserEvent } from "../modules/users/user-events";

const RETRY_DELAY_MS = 5_000;
/** Mensagens novas saem por aqui (o backend manda o push) */
export const CHAT_EXCHANGE = "raiji.chat";

interface Consumer {
  /** Nome curto para os logs */
  name: string;
  exchange: string;
  queue: string;
  routingKey: string;
  handle: (payload: unknown, log: FastifyBaseLogger) => Promise<unknown>;
}

const CONSUMERS: Consumer[] = [
  {
    // Ciclo de vida do usuário (Keycloak -> raiji.users)
    name: "usuários",
    exchange: Bun.env.RABBITMQ_USERS_EXCHANGE || "raiji.users",
    queue: "chat.user-events",
    routingKey: "user.*",
    handle: handleUserEvent,
  },
  {
    // Grupos de carona (backend -> raiji.rides)
    name: "caronas",
    exchange: Bun.env.RABBITMQ_RIDES_EXCHANGE || "raiji.rides",
    queue: "chat.ride-events",
    routingKey: "ride.*",
    handle: (payload) => handleRideEvent(payload),
  },
];

declare module "fastify" {
  interface FastifyInstance {
    /** Publica um evento (JSON). Sem broker, só registra no log: o chat continua funcionando. */
    publishEvent: (exchange: string, routingKey: string, payload: unknown) => void;
  }
}

async function consume(channel: Channel, consumer: Consumer, log: FastifyBaseLogger) {
  const deadLetterExchange = `${consumer.exchange}.dlx`;
  await channel.assertExchange(consumer.exchange, "topic", { durable: true });
  await channel.assertExchange(deadLetterExchange, "fanout", { durable: true });
  await channel.assertQueue(`${consumer.queue}.dlq`, { durable: true });
  await channel.bindQueue(`${consumer.queue}.dlq`, deadLetterExchange, "");
  await channel.assertQueue(consumer.queue, { durable: true, deadLetterExchange });
  await channel.bindQueue(consumer.queue, consumer.exchange, consumer.routingKey);

  await channel.consume(consumer.queue, async (msg: ConsumeMessage | null) => {
    if (!msg) return;
    try {
      await consumer.handle(JSON.parse(msg.content.toString()), log);
      channel.ack(msg);
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof z.ZodError) {
        log.warn({ err, routingKey: msg.fields.routingKey }, `evento de ${consumer.name} inválido: enviado à DLQ`);
        channel.nack(msg, false, false);
        return;
      }
      // Falha temporária (Mongo fora do ar, evento fora de ordem): tenta de novo em instantes
      if (!(err instanceof RideNotFoundError)) log.error({ err }, `falha ao processar evento de ${consumer.name}`);
      setTimeout(() => {
        try {
          channel.nack(msg, false, true);
        } catch {
          // canal fechado: o broker reentrega a mensagem não confirmada sozinho
        }
      }, RETRY_DELAY_MS);
    }
  });
  log.info({ queue: consumer.queue, exchange: consumer.exchange }, `rabbitmq: consumindo eventos de ${consumer.name}`);
}

/**
 * Mensageria do chat:
 * - consome eventos de usuário (Keycloak) e de carona (backend), cada um com sua DLQ;
 * - publica `message.created` em `raiji.chat` para o backend mandar o push.
 *
 * Reconexão automática do amqplib (`recovery`): o `setup` recria tudo a cada conexão.
 * Não bloqueia a subida do chat: sem broker, a API continua no ar (sem grupos e sem push).
 */
export default fp(async (app) => {
  let publisher: ConfirmChannel | null = null;
  app.decorate("publishEvent", (exchange: string, routingKey: string, payload: unknown) => {
    if (!publisher) {
      app.log.warn({ routingKey }, "rabbitmq indisponível: evento não publicado");
      return;
    }
    try {
      publisher.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
        contentType: "application/json",
        persistent: true,
      });
    } catch (err) {
      app.log.warn({ err, routingKey }, "falha ao publicar evento");
    }
  });

  const uri = Bun.env.RABBITMQ_URI;
  if (!uri) {
    app.log.warn("RABBITMQ_URI não definido: grupos de carona, usuários e push desativados");
    return;
  }

  async function setup(model: ChannelModel) {
    const channel = await model.createChannel();
    await channel.prefetch(10);
    for (const consumer of CONSUMERS) await consume(channel, consumer, app.log);

    const pub = await model.createConfirmChannel();
    await pub.assertExchange(CHAT_EXCHANGE, "topic", { durable: true });
    pub.on("close", () => {
      if (publisher === pub) publisher = null;
    });
    publisher = pub;
  }

  const connection = await amqp.connect(uri, {
    clientProperties: { connection_name: "raiji-chat" },
    recovery: { initialDelay: 500, maxDelay: 15_000, waitForConnect: false, setup },
  });
  connection.on("disconnect", (err) => {
    publisher = null;
    app.log.warn({ err }, "rabbitmq: desconectado, reconectando");
  });
  connection.on("reconnect-scheduled", ({ attempt, delay }) =>
    app.log.info({ attempt, delay }, "rabbitmq: nova tentativa de conexão agendada"),
  );
  connection.on("error", (err) => app.log.error({ err }, "rabbitmq: erro"));

  app.addHook("onClose", async () => {
    await connection.close().catch(() => {});
  });
});
