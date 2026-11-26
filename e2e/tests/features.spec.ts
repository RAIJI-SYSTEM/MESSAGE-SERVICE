import { test, expect } from "@playwright/test";
import { CHAT, auth, createUser } from "../helpers/raiji";

const idOf = (body: Record<string, unknown>) => String(body.id ?? body._id);

test.describe("MESSAGE-SERVICE — funcionalidades", () => {
  test("grupos: criar, listar, renomear, membros e excluir", async ({ request }) => {
    const owner = await createUser(request, "PASSENGER");
    const member = await createUser(request, "PASSENGER");
    const extra = await createUser(request, "PASSENGER");

    const created = await request.post(`${CHAT}/groups`, {
      headers: auth(owner.token),
      data: { name: "Grupo E2E", memberIds: [member.sub, extra.sub] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const group = await created.json();
    const groupId = idOf(group);
    expect(groupId).toBeTruthy();

    const listed = await request.get(`${CHAT}/groups`, { headers: auth(member.token) });
    expect(listed.status(), await listed.text()).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(groupId);

    const detail = await request.get(`${CHAT}/groups/${groupId}`, {
      headers: auth(member.token),
    });
    expect(detail.status(), await detail.text()).toBe(200);

    const renamed = await request.patch(`${CHAT}/groups/${groupId}`, {
      headers: auth(owner.token),
      data: { name: "Grupo renomeado E2E" },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Grupo renomeado E2E" });

    const forbidden = await request.patch(`${CHAT}/groups/${groupId}`, {
      headers: auth(member.token),
      data: { name: "Tentativa" },
    });
    expect(forbidden.status()).toBe(403);

    const added = await createUser(request, "PASSENGER");
    const add = await request.post(`${CHAT}/conversations/${groupId}/members`, {
      headers: auth(owner.token),
      data: { userId: added.sub },
    });
    expect(add.status(), await add.text()).toBe(204);

    const members = await request.get(`${CHAT}/conversations/${groupId}/members`, {
      headers: auth(owner.token),
    });
    expect(members.status(), await members.text()).toBe(200);
    expect(JSON.stringify(await members.json())).toContain(added.sub);

    const remove = await request.delete(
      `${CHAT}/conversations/${groupId}/members/${added.sub}`,
      { headers: auth(owner.token) },
    );
    expect(remove.status(), await remove.text()).toBe(204);

    const read = await request.post(`${CHAT}/conversations/${groupId}/read`, {
      headers: auth(member.token),
    });
    expect(read.status()).toBe(204);

    const deleted = await request.delete(`${CHAT}/groups/${groupId}`, {
      headers: auth(owner.token),
    });
    expect(deleted.status()).toBe(204);

    const gone = await request.get(`${CHAT}/groups/${groupId}`, {
      headers: auth(owner.token),
    });
    expect(gone.status()).toBe(404);
  });

  test("mensagens: vazio, texto, paginação e anexo inválido", async ({ request }) => {
    const userA = await createUser(request, "PASSENGER");
    const userB = await createUser(request, "PASSENGER");

    const direct = await request.post(`${CHAT}/conversations/direct`, {
      headers: auth(userA.token),
      data: { userId: userB.sub },
    });
    expect(direct.status(), await direct.text()).toBe(200);
    const conversationId = idOf(await direct.json());

    const empty = await request.post(`${CHAT}/conversations/${conversationId}/messages`, {
      headers: auth(userA.token),
      data: { text: "" },
    });
    expect(empty.status()).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "empty_message" });

    const text = `Mensagem de recurso ${Date.now()}`;
    const sent = await request.post(`${CHAT}/conversations/${conversationId}/messages`, {
      headers: auth(userA.token),
      data: { text },
    });
    expect(sent.status(), await sent.text()).toBe(201);

    const page = await request.get(
      `${CHAT}/conversations/${conversationId}/messages?limit=10`,
      { headers: auth(userB.token) },
    );
    expect(page.status(), await page.text()).toBe(200);
    expect(JSON.stringify(await page.json())).toContain(text);

    const attachment = await request.post(
      `${CHAT}/conversations/${conversationId}/attachments`,
      {
        headers: auth(userA.token),
        data: { name: "perigoso.svg", mimeType: "image/svg+xml", sizeBytes: 10 },
      },
    );
    expect(attachment.status()).toBe(415);
    expect(await attachment.json()).toMatchObject({ error: "unsupported_media_type" });
  });

  test("administração: listar/criar/excluir usuários e moderar conversa", async ({ request }) => {
    const admin = await createUser(request, "PASSENGER", ["chat-admin"]);
    const conversationOwner = await createUser(request, "PASSENGER");

    const users = await request.get(`${CHAT}/users?limit=5`, { headers: auth(admin.token) });
    expect(users.status(), await users.text()).toBe(200);

    const target = await createUser(request, "PASSENGER");
    const created = await request.post(`${CHAT}/users`, {
      headers: auth(admin.token),
      data: { keycloakId: target.sub },
    });
    expect(created.status(), await created.text()).toBe(200);

    const detail = await request.get(`${CHAT}/users/${target.sub}`, {
      headers: auth(admin.token),
    });
    expect(detail.status(), await detail.text()).toBe(200);

    const conversation = await request.post(`${CHAT}/conversations/direct`, {
      headers: auth(conversationOwner.token),
      data: { userId: target.sub },
    });
    expect(conversation.status(), await conversation.text()).toBe(200);
    const conversationId = idOf(await conversation.json());

    const moderated = await request.patch(`${CHAT}/conversations/${conversationId}`, {
      headers: auth(admin.token),
      data: { expiresAt: null },
    });
    expect(moderated.status(), await moderated.text()).toBe(200);

    const deleted = await request.delete(`${CHAT}/conversations/${conversationId}`, {
      headers: auth(admin.token),
    });
    expect(deleted.status()).toBe(204);

    const removedUser = await request.delete(`${CHAT}/users/${target.sub}`, {
      headers: auth(admin.token),
    });
    expect(removedUser.status()).toBe(204);
  });
});
