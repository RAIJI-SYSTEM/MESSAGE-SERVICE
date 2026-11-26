import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Regressão][Análise de Falhas] Eventos de carona (RabbitMQ).
 *
 * O chat depende desses eventos para criar/atualizar o grupo e para expirar a
 * conversa depois da viagem. O teste cobre idempotência, evento fora de ordem
 * (RideNotFoundError -> retry) e limpeza de membros.
 */
const conversationFindOne = vi.hoisted(() => vi.fn());
const conversationFindOneAndUpdate = vi.hoisted(() => vi.fn());
const conversationUpdateOne = vi.hoisted(() => vi.fn());
const groupUpdateOne = vi.hoisted(() => vi.fn());
const memberDeleteOne = vi.hoisted(() => vi.fn());
const memberBulkWrite = vi.hoisted(() => vi.fn());
const memberDeleteMany = vi.hoisted(() => vi.fn());
const addMembers = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/conversations/conversation.model", () => ({
  ConversationModel: {
    findOne: conversationFindOne,
    findOneAndUpdate: conversationFindOneAndUpdate,
    updateOne: conversationUpdateOne,
  },
}));
vi.mock("../../src/modules/conversations/conversation-member.model", () => ({
  ConversationMemberModel: {
    deleteOne: memberDeleteOne,
    bulkWrite: memberBulkWrite,
    deleteMany: memberDeleteMany,
  },
}));
vi.mock("../../src/modules/conversations/group.model", () => ({
  GroupModel: { updateOne: groupUpdateOne },
}));
vi.mock("../../src/modules/conversations/conversation.service", () => ({ addMembers }));

import { RideNotFoundError, handleRideEvent } from "../../src/modules/rides/ride-events";

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  conversationFindOneAndUpdate.mockResolvedValue({ _id: "c1" });
  conversationFindOne.mockResolvedValue({ _id: "c1" });
  conversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
});

describe("[Regressão] ride.created", () => {
  it("cria conversa, grupo padrão e adiciona motorista + passageiros", async () => {
    await handleRideEvent({
      type: "ride.created",
      rideId: "r1",
      driverId: "d1",
      passengerIds: ["p1", "p2"],
    });

    expect(conversationFindOneAndUpdate).toHaveBeenCalledWith(
      { rideId: "r1" },
      { $setOnInsert: { type: "group" } },
      { upsert: true, returnDocument: "after" },
    );
    expect(groupUpdateOne).toHaveBeenCalledWith(
      { conversationId: "c1" },
      { $setOnInsert: { name: "Carona", createdBy: "d1" } },
      { upsert: true },
    );
    expect(addMembers).toHaveBeenCalledWith("c1", ["d1", "p1", "p2"]);
  });

  it("usa o nome enviado pelo backend quando existe", async () => {
    await handleRideEvent({
      type: "ride.created",
      rideId: "r1",
      driverId: "d1",
      name: "Carona para Campinas",
    });

    expect(groupUpdateOne).toHaveBeenCalledWith(
      { conversationId: "c1" },
      { $setOnInsert: { name: "Carona para Campinas", createdBy: "d1" } },
      { upsert: true },
    );
  });
});

describe("[Análise de Falhas] participantes", () => {
  it("entrada de participante adiciona ao grupo", async () => {
    await handleRideEvent({ type: "ride.participant_joined", rideId: "r1", userId: "p1" });

    expect(addMembers).toHaveBeenCalledWith("c1", ["p1"]);
  });

  it("saída de participante remove do grupo", async () => {
    await handleRideEvent({ type: "ride.participant_left", rideId: "r1", userId: "p1" });

    expect(memberDeleteOne).toHaveBeenCalledWith({ conversationId: "c1", userId: "p1" });
  });

  it("evento antes de ride.created vira RideNotFoundError (retry, não DLQ)", async () => {
    conversationFindOne.mockResolvedValue(null);

    await expect(
      handleRideEvent({ type: "ride.participant_joined", rideId: "r1", userId: "p1" }),
    ).rejects.toBeInstanceOf(RideNotFoundError);
  });
});

describe("[Análise de Falhas] fim da carona", () => {
  it("finished define expiração para 3 dias depois", async () => {
    const occurredAt = "2026-11-26T12:00:00.000Z";

    await handleRideEvent({ type: "ride.finished", rideId: "r1", occurredAt });

    expect(conversationUpdateOne).toHaveBeenCalledWith(
      { rideId: "r1" },
      { expiresAt: new Date(Date.parse(occurredAt) + THREE_DAYS) },
    );
  });

  it("reentrega de conversa já removida e vencida não gera erro", async () => {
    conversationUpdateOne.mockResolvedValue({ matchedCount: 0 });

    await expect(
      handleRideEvent({ type: "ride.cancelled", rideId: "r1", occurredAt: "2020-01-01T00:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });

  it("conversa inexistente com expiração futura gera retry", async () => {
    conversationUpdateOne.mockResolvedValue({ matchedCount: 0 });

    await expect(
      handleRideEvent({ type: "ride.cancelled", rideId: "r1", occurredAt: new Date().toISOString() }),
    ).rejects.toBeInstanceOf(RideNotFoundError);
  });
});

describe("[Regressão] ride.synced", () => {
  it("não cria grupo para motorista sozinho quando ainda não existe conversa", async () => {
    conversationFindOne.mockResolvedValue(null);

    await handleRideEvent({
      type: "ride.synced",
      rideId: "r1",
      driverId: "d1",
      driverName: "Carlos",
      name: "Carona",
      origin: "São Paulo",
      destination: "Campinas",
      status: "PLANNED",
      occurredAt: "2026-11-26T12:00:00.000Z",
      passengers: [],
    });

    expect(conversationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(groupUpdateOne).not.toHaveBeenCalled();
  });

  it("sincroniza membros, papéis e remove quem saiu", async () => {
    conversationFindOne.mockResolvedValue({ _id: "c1" });

    await handleRideEvent({
      type: "ride.synced",
      rideId: "r1",
      driverId: "d1",
      driverName: "Carlos",
      name: "Carona",
      origin: "São Paulo",
      destination: "Campinas",
      status: "PLANNED",
      occurredAt: "2026-11-26T12:00:00.000Z",
      passengers: [
        { userId: "p1", name: "Ana" },
        { userId: "d1", name: "Carlos" },
      ],
    });

    expect(conversationFindOneAndUpdate).toHaveBeenCalledWith(
      { rideId: "r1" },
      expect.objectContaining({
        $setOnInsert: { type: "group" },
        $set: expect.objectContaining({ expiresAt: null }),
      }),
      { upsert: true, returnDocument: "after" },
    );
    expect(groupUpdateOne).toHaveBeenCalledWith(
      { conversationId: "c1" },
      { $set: { name: "Carona" }, $setOnInsert: { createdBy: "d1" } },
      { upsert: true },
    );

    const operations = memberBulkWrite.mock.calls[0]![0] as Array<{
      updateOne: { filter: unknown; update: { $set: { role: string } } };
    }>;
    expect(operations.map((o) => o.updateOne.filter)).toEqual([
      { conversationId: "c1", userId: "d1" },
      { conversationId: "c1", userId: "p1" },
    ]);
    expect(operations.map((o) => o.updateOne.update.$set.role)).toEqual(["driver", "passenger"]);
    expect(memberDeleteMany).toHaveBeenCalledWith({
      conversationId: "c1",
      userId: { $nin: ["d1", "p1"] },
    });
  });

  it("carona encerrada agenda expiração do grupo", async () => {
    const occurredAt = "2026-11-26T12:00:00.000Z";
    conversationFindOne.mockResolvedValue({ _id: "c1" });

    await handleRideEvent({
      type: "ride.synced",
      rideId: "r1",
      driverId: "d1",
      driverName: "Carlos",
      name: "Carona",
      origin: "São Paulo",
      destination: "Campinas",
      status: "COMPLETED",
      occurredAt,
      passengers: [{ userId: "p1", name: "Ana" }],
    });

    expect(conversationFindOneAndUpdate).toHaveBeenCalledWith(
      { rideId: "r1" },
      expect.objectContaining({
        $set: expect.objectContaining({ expiresAt: new Date(Date.parse(occurredAt) + THREE_DAYS) }),
      }),
      { upsert: true, returnDocument: "after" },
    );
  });
});
