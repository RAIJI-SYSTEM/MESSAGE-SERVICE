import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ConversationMemberModel } from "../../src/modules/conversations/conversation-member.model";
import { ConversationModel } from "../../src/modules/conversations/conversation.model";
import { GroupModel } from "../../src/modules/conversations/group.model";
import { handleRideEvent, RideNotFoundError } from "../../src/modules/rides/ride-events";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

describe("handleRideEvent — ride.created", () => {
  it("cria a conversa, o grupo e os membros (motorista + passageiros)", async () => {
    await handleRideEvent({
      type: "ride.created",
      rideId: "ride-1",
      driverId: "driver-1",
      passengerIds: ["p-1", "p-2"],
      name: "São Paulo → Campinas",
    });

    const conversation = await ConversationModel.findOne({ rideId: "ride-1" });
    expect(conversation).not.toBeNull();
    expect(conversation!.type).toBe("group");
    expect((await GroupModel.findOne({ conversationId: conversation!._id }))!.name).toBe("São Paulo → Campinas");

    const members = await ConversationMemberModel.find({ conversationId: conversation!._id }).lean();
    expect(members.map((m) => m.userId).sort()).toEqual(["driver-1", "p-1", "p-2"]);
  });

  it("usa o nome padrão e aceita evento sem passageiros", async () => {
    await handleRideEvent({ type: "ride.created", rideId: "ride-2", driverId: "driver-1" });
    const conversation = await ConversationModel.findOne({ rideId: "ride-2" });
    expect((await GroupModel.findOne({ conversationId: conversation!._id }))!.name).toBe("Carona");
  });

  it("é idempotente (reentrega não duplica)", async () => {
    const event = { type: "ride.created", rideId: "ride-3", driverId: "driver-1", passengerIds: ["p-1"] };
    await handleRideEvent(event);
    await handleRideEvent(event);
    expect(await ConversationModel.countDocuments({ rideId: "ride-3" })).toBe(1);
    expect(await ConversationMemberModel.countDocuments()).toBe(2);
  });
});

describe("handleRideEvent — participantes", () => {
  it("entra no grupo da carona", async () => {
    await handleRideEvent({ type: "ride.created", rideId: "ride-4", driverId: "driver-1" });
    await handleRideEvent({ type: "ride.participant_joined", rideId: "ride-4", userId: "p-9" });

    const conversation = await ConversationModel.findOne({ rideId: "ride-4" });
    const member = await ConversationMemberModel.findOne({ conversationId: conversation!._id, userId: "p-9" });
    expect(member).not.toBeNull();
  });

  it("sai do grupo da carona", async () => {
    await handleRideEvent({ type: "ride.created", rideId: "ride-5", driverId: "driver-1", passengerIds: ["p-1"] });
    await handleRideEvent({ type: "ride.participant_left", rideId: "ride-5", userId: "p-1" });

    const conversation = await ConversationModel.findOne({ rideId: "ride-5" });
    expect(await ConversationMemberModel.countDocuments({ conversationId: conversation!._id, userId: "p-1" })).toBe(0);
  });

  it("devolve o evento à fila quando a carona ainda não tem conversa", async () => {
    await expect(
      handleRideEvent({ type: "ride.participant_joined", rideId: "inexistente", userId: "p-1" }),
    ).rejects.toBeInstanceOf(RideNotFoundError);
    await expect(
      handleRideEvent({ type: "ride.participant_left", rideId: "inexistente", userId: "p-1" }),
    ).rejects.toBeInstanceOf(RideNotFoundError);
  });
});

describe("handleRideEvent — fim da carona", () => {
  it("agenda a remoção do grupo 3 dias depois", async () => {
    await handleRideEvent({ type: "ride.created", rideId: "ride-6", driverId: "driver-1" });
    const occurredAt = iso();
    await handleRideEvent({ type: "ride.finished", rideId: "ride-6", occurredAt });

    const conversation = await ConversationModel.findOne({ rideId: "ride-6" }).lean();
    expect(conversation!.expiresAt!.getTime()).toBe(Date.parse(occurredAt) + 3 * 24 * 60 * 60 * 1000);
  });

  it("cancelamento segue a mesma regra", async () => {
    await handleRideEvent({ type: "ride.created", rideId: "ride-7", driverId: "driver-1" });
    await handleRideEvent({ type: "ride.cancelled", rideId: "ride-7", occurredAt: iso() });
    const conversation = await ConversationModel.findOne({ rideId: "ride-7" }).lean();
    expect(conversation!.expiresAt).toBeInstanceOf(Date);
  });

  it("reentrega de grupo já removido não volta para a fila se o prazo passou", async () => {
    await expect(
      handleRideEvent({ type: "ride.finished", rideId: "sumiu", occurredAt: iso(-4 * 24 * 60 * 60 * 1000) }),
    ).resolves.toBeUndefined();
  });

  it("evento fora de ordem (prazo ainda no futuro) volta para a fila", async () => {
    await expect(
      handleRideEvent({ type: "ride.cancelled", rideId: "sumiu", occurredAt: iso() }),
    ).rejects.toBeInstanceOf(RideNotFoundError);
  });
});

describe("handleRideEvent — ride.synced", () => {
  const synced = (overrides: Record<string, unknown> = {}) => ({
    type: "ride.synced",
    rideId: "ride-s",
    driverId: "driver-1",
    driverName: "Carlos",
    name: "Grupo da viagem",
    origin: "São Paulo",
    destination: "Campinas",
    status: "IN_PROGRESS",
    occurredAt: iso(),
    passengers: [
      { userId: "p-1", name: "Ana" },
      { userId: "p-2", name: null },
      { userId: "driver-1", name: "Carlos" },
    ],
    ...overrides,
  });

  it("não cria grupo quando o motorista está sozinho e ainda não existe", async () => {
    await handleRideEvent(synced({ passengers: [] }));
    expect(await ConversationModel.countDocuments()).toBe(0);
  });

  it("espelha a carona no grupo (contexto, nome, papéis)", async () => {
    await handleRideEvent(synced());

    const conversation = await ConversationModel.findOne({ rideId: "ride-s" }).lean();
    expect(conversation!.context).toMatchObject({ kind: "ride", refId: "ride-s", origin: "São Paulo", subId: null });
    expect(conversation!.expiresAt).toBeNull();

    const group = await GroupModel.findOne({ conversationId: conversation!._id }).lean();
    expect(group).toMatchObject({ name: "Grupo da viagem", createdBy: "driver-1" });

    const members = await ConversationMemberModel.find({ conversationId: conversation!._id }).lean();
    expect(members).toHaveLength(3); // driver repetido na lista vira um só
    expect(members.find((m) => m.userId === "driver-1")).toMatchObject({ role: "driver", name: "Carlos" });
    expect(members.find((m) => m.userId === "p-1")).toMatchObject({ role: "passenger", name: "Ana" });
    expect(members.find((m) => m.userId === "p-2")).toMatchObject({ role: "passenger" });
  });

  it("remove quem saiu da carona", async () => {
    await handleRideEvent(synced());
    await handleRideEvent(synced({ passengers: [{ userId: "p-1", name: "Ana" }] }));

    const conversation = await ConversationModel.findOne({ rideId: "ride-s" }).lean();
    const members = await ConversationMemberModel.find({ conversationId: conversation!._id }).lean();
    expect(members.map((m) => m.userId).sort()).toEqual(["driver-1", "p-1"]);
  });

  it("carona concluída/cancelada some 3 dias depois", async () => {
    const occurredAt = iso();
    await handleRideEvent(synced({ status: "COMPLETED", occurredAt }));
    const conversation = await ConversationModel.findOne({ rideId: "ride-s" }).lean();
    expect(conversation!.expiresAt!.getTime()).toBe(Date.parse(occurredAt) + 3 * 24 * 60 * 60 * 1000);
  });

  it("não grava nome nulo do motorista", async () => {
    await handleRideEvent(synced({ driverName: null }));
    const conversation = await ConversationModel.findOne({ rideId: "ride-s" }).lean();
    const driver = await ConversationMemberModel.findOne({ conversationId: conversation!._id, userId: "driver-1" }).lean();
    expect(driver!.name).toBeNull();
    expect(driver!.role).toBe("driver");
  });
});

describe("handleRideEvent — payload inválido", () => {
  it("lança ZodError (vai para a DLQ, não adianta repetir)", async () => {
    await expect(handleRideEvent({ type: "ride.desconhecido" })).rejects.toBeInstanceOf(z.ZodError);
    await expect(handleRideEvent({ type: "ride.created", rideId: "" })).rejects.toBeInstanceOf(z.ZodError);
  });
});
