import { test, expect } from "@playwright/test";
import {
  CHAT,
  KONG,
  acceptSeat,
  auth,
  createRide,
  createUser,
  createVehicle,
  requestSeat,
  waitForChatByRide,
} from "../helpers/raiji";

/**
 * E2E de sistema do MESSAGE-SERVICE.
 *
 * Cobre o chat isolado (API) e a integração real com o monólito:
 * carona criada/aceita -> evento RabbitMQ -> grupo disponível no chat.
 */
test.describe("MESSAGE-SERVICE — sistema", () => {
  test("health indireto, autenticação e bloqueio sem token", async ({ request }) => {
    const anonymous = await request.get(`${CHAT}/conversations`);
    expect(anonymous.status()).toBe(401);

    const user = await createUser(request, "PASSENGER");
    const me = await request.get(`${CHAT}/users/me`, { headers: auth(user.token) });
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ keycloakId: user.sub });
  });

  test("conversa direta: enviar e ler mensagem entre dois usuários", async ({ request }) => {
    const userA = await createUser(request, "PASSENGER");
    const userB = await createUser(request, "PASSENGER");

    const created = await request.post(`${CHAT}/conversations/direct`, {
      headers: auth(userA.token),
      data: { userId: userB.sub, name: "Contato E2E" },
    });
    expect(created.status(), await created.text()).toBe(200);
    const createdBody = await created.json();
    const conversationId = (createdBody.id ?? createdBody._id) as string;
    expect(conversationId).toBeTruthy();

    const listed = await request.get(`${CHAT}/conversations`, { headers: auth(userA.token) });
    expect(listed.status(), await listed.text()).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(conversationId);

    const text = `Mensagem E2E ${Date.now()}`;
    const sent = await request.post(`${CHAT}/conversations/${conversationId}/messages`, {
      headers: auth(userA.token),
      data: { text },
    });
    expect(sent.status(), await sent.text()).toBe(201);

    const messages = await request.get(`${CHAT}/conversations/${conversationId}/messages`, {
      headers: auth(userB.token),
    });
    expect(messages.status(), await messages.text()).toBe(200);
    expect(JSON.stringify(await messages.json())).toContain(text);
  });

  test("evento de carona cria o grupo e permite conversar", async ({ request }) => {
    const driver = await createUser(request, "DRIVER");
    const passenger = await createUser(request, "PASSENGER");

    const vehicleId = await createVehicle(request, driver.token);
    const ride = await createRide(request, driver.token, vehicleId);
    const requestId = await requestSeat(request, passenger.token, ride.id);
    await acceptSeat(request, driver.token, ride.id, requestId);

    const conversationId = await waitForChatByRide(request, driver.token, ride.id);

    const text = `Grupo da carona E2E ${Date.now()}`;
    const sent = await request.post(`${CHAT}/conversations/${conversationId}/messages`, {
      headers: auth(driver.token),
      data: { text },
    });
    expect(sent.status(), await sent.text()).toBe(201);

    const passengerMessages = await request.get(
      `${CHAT}/conversations/${conversationId}/messages`,
      { headers: auth(passenger.token) },
    );
    expect(passengerMessages.status(), await passengerMessages.text()).toBe(200);
    expect(JSON.stringify(await passengerMessages.json())).toContain(text);
  });
});
