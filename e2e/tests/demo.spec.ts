import { test, expect } from "@playwright/test";
import { CHAT, type E2EUser, auth, createUser } from "../helpers/raiji";
import { demoStep, startDemo } from "../helpers/demo";

const idOf = (body: Record<string, unknown>) => String(body.id ?? body._id);

/**
 * Tour guiado em vídeo do chat: o fluxo real de API é desenhado passo a passo
 * em uma página do navegador para que o Playwright grave o vídeo.
 */
test.describe("MESSAGE-SERVICE — tour guiado em vídeo", () => {
  test("jornada completa: grupo, membros, mensagens e exclusão", async ({ page }) => {
    await startDemo(
      page,
      "MESSAGE-SERVICE",
      "Jornada completa do chat",
      "Duas pessoas, grupo, inclusão de membro, mensagem, leitura e exclusão — "
        + "passo a passo pelo fluxo real da API do chat.",
    );

    let owner!: E2EUser;
    let member!: E2EUser;
    let groupId = "";
    const groupName = `Grupo tour ${Date.now()}`;
    const messageText = `Mensagem do tour E2E ${Date.now()}`;

    await demoStep(page, "Criar a pessoa dona do grupo", async () => {
      owner = await createUser(page.request, "PASSENGER");
      return `Conta ${owner.username}`;
    });

    await demoStep(page, "Criar a segunda pessoa", async () => {
      member = await createUser(page.request, "PASSENGER");
      return `Conta ${member.username}`;
    });

    await demoStep(page, "Criar grupo com os dois membros", async () => {
      const created = await page.request.post(`${CHAT}/groups`, {
        headers: auth(owner.token),
        data: { name: groupName, memberIds: [member.sub] },
      });
      expect(created.status(), await created.text()).toBe(201);
      groupId = idOf(await created.json());
      return `Grupo ${groupId}`;
    });

    await demoStep(page, "Listar os grupos da segunda pessoa", async () => {
      const listed = await page.request.get(`${CHAT}/groups`, {
        headers: auth(member.token),
      });
      expect(listed.status(), await listed.text()).toBe(200);
      expect(JSON.stringify(await listed.json())).toContain(groupId);
      return "Grupo visível para o membro";
    });

    await demoStep(page, "Renomear o grupo", async () => {
      const renamed = await page.request.patch(`${CHAT}/groups/${groupId}`, {
        headers: auth(owner.token),
        data: { name: `${groupName} (renomeado)` },
      });
      expect(renamed.status(), await renamed.text()).toBe(200);
      return "Novo nome aplicado";
    });

    await demoStep(page, "Enviar mensagem no grupo", async () => {
      const sent = await page.request.post(`${CHAT}/conversations/${groupId}/messages`, {
        headers: auth(owner.token),
        data: { text: messageText },
      });
      expect(sent.status(), await sent.text()).toBe(201);
      return "Mensagem enviada";
    });

    await demoStep(page, "Ler a mensagem como o outro membro", async () => {
      const messages = await page.request.get(
        `${CHAT}/conversations/${groupId}/messages?limit=10`,
        { headers: auth(member.token) },
      );
      expect(messages.status(), await messages.text()).toBe(200);
      expect(JSON.stringify(await messages.json())).toContain(messageText);
      return "Mensagem confirmada";
    });

    await demoStep(page, "Excluir o grupo", async () => {
      const deleted = await page.request.delete(`${CHAT}/groups/${groupId}`, {
        headers: auth(owner.token),
      });
      expect(deleted.status(), await deleted.text()).toBe(204);
      return "Grupo removido";
    });

    await demoStep(page, "Confirmar que o grupo não existe mais", async () => {
      const gone = await page.request.get(`${CHAT}/groups/${groupId}`, {
        headers: auth(owner.token),
      });
      expect(gone.status()).toBe(404);
      return "Exclusão confirmada (HTTP 404)";
    });
  });
});
