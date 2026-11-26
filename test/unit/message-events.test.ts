import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Regressão] Evento `message.created`.
 *
 * O evento alimenta o push do backend. O teste fixa quem recebe, qual título e
 * qual prévia (texto ou tipo do anexo), incluindo o corte em 140 caracteres.
 */
const memberFind = vi.hoisted(() => vi.fn());
const groupFindOne = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/conversations/conversation-member.model", () => ({
  ConversationMemberModel: { find: memberFind },
}));
vi.mock("../../src/modules/conversations/group.model", () => ({
  GroupModel: { findOne: groupFindOne },
}));

import { messageCreatedEvent } from "../../src/modules/messages/message-events";

const lean = <T>(value: T) => ({ lean: vi.fn(async () => value) });

beforeEach(() => {
  memberFind.mockReset();
  groupFindOne.mockReset();
});

const sender = { id: "u1", isAdmin: false, name: "Ana Souza" };

describe("[Regressão] messageCreatedEvent", () => {
  it("conversa direta: usa o nome do remetente e exclui o próprio remetente", async () => {
    memberFind.mockReturnValue(lean([
      { userId: "u1", name: "Ana" },
      { userId: "u2", name: "Bia" },
    ]));
    groupFindOne.mockReturnValue(lean(null));

    const event = await messageCreatedEvent("c1", sender, {
      text: "Oi, chego em 10 minutos",
      attachments: [],
    });

    expect(event).toEqual({
      conversationId: "c1",
      senderId: "u1",
      title: "Ana Souza",
      preview: "Oi, chego em 10 minutos",
      recipientIds: ["u2"],
    });

    // Consulta escopada na conversa e projeção enxuta (não carregar tudo)
    expect(memberFind).toHaveBeenCalledWith({ conversationId: "c1" }, "userId name");
    expect(groupFindOne).toHaveBeenCalledWith({ conversationId: "c1" }, "name");
  });

  it("grupo: título do grupo e prévia com o primeiro nome", async () => {
    memberFind.mockReturnValue(lean([
      { userId: "u1", name: "Ana" },
      { userId: "u2", name: "Bia" },
    ]));
    groupFindOne.mockReturnValue(lean({ name: "Carona Campinas" }));

    const event = await messageCreatedEvent("c1", sender, { text: "Bora?", attachments: [] });

    expect(event).toMatchObject({
      title: "Carona Campinas",
      preview: "Ana: Bora?",
      recipientIds: ["u2"],
    });
  });

  it("sem texto usa a prévia do tipo do anexo", async () => {
    memberFind.mockReturnValue(lean([{ userId: "u1", name: "Ana" }, { userId: "u2", name: "Bia" }]));
    groupFindOne.mockReturnValue(lean(null));

    const foto = await messageCreatedEvent("c1", sender, { text: "  ", attachments: [{ type: "image" }] });
    const audio = await messageCreatedEvent("c1", sender, { text: "", attachments: [{ type: "audio" }] });
    const doc = await messageCreatedEvent("c1", sender, { text: "", attachments: [{ type: "document" }] });

    expect(foto?.preview).toBe("📷 Foto");
    expect(audio?.preview).toBe("🎤 Áudio");
    expect(doc?.preview).toBe("📎 Documento");
  });

  it("corta a prévia em 140 caracteres com reticências", async () => {
    memberFind.mockReturnValue(lean([{ userId: "u1", name: "Ana" }, { userId: "u2", name: "Bia" }]));
    groupFindOne.mockReturnValue(lean(null));

    const event = await messageCreatedEvent("c1", sender, { text: "x".repeat(200), attachments: [] });

    expect(event?.preview).toHaveLength(140);
    expect(event?.preview.endsWith("…")).toBe(true);
  });

  it("texto com exatamente 140 caracteres não é cortado", async () => {
    memberFind.mockReturnValue(lean([{ userId: "u1", name: "Ana" }, { userId: "u2", name: "Bia" }]));
    groupFindOne.mockReturnValue(lean(null));

    const texto = "y".repeat(140);
    const event = await messageCreatedEvent("c1", sender, { text: texto, attachments: [] });

    expect(event?.preview).toBe(texto);
    expect(event?.preview.endsWith("…")).toBe(false);
  });

  it("anexo de tipo desconhecido usa a prévia genérica", async () => {
    memberFind.mockReturnValue(lean([{ userId: "u1", name: "Ana" }, { userId: "u2", name: "Bia" }]));
    groupFindOne.mockReturnValue(lean(null));

    const event = await messageCreatedEvent("c1", sender, {
      text: "",
      attachments: [{ type: "video" }],
    });

    expect(event?.preview).toBe("📎 Arquivo");
  });

  it("sem texto e sem anexo usa 'Nova mensagem'", async () => {
    memberFind.mockReturnValue(lean([{ userId: "u1", name: "Ana" }, { userId: "u2", name: "Bia" }]));
    groupFindOne.mockReturnValue(lean(null));

    const event = await messageCreatedEvent("c1", sender, { text: "", attachments: [] });

    expect(event?.preview).toBe("Nova mensagem");
  });

  it("sem destinatários não publica evento", async () => {
    memberFind.mockReturnValue(lean([{ userId: "u1", name: "Ana" }]));
    groupFindOne.mockReturnValue(lean(null));

    await expect(
      messageCreatedEvent("c1", sender, { text: "sozinho", attachments: [] }),
    ).resolves.toBeNull();
  });

  it("remetente sem nome no token usa o nome gravado; sem nenhum, 'Alguém'", async () => {
    memberFind.mockReturnValue(lean([{ userId: "u2", name: "Bia" }]));
    groupFindOne.mockReturnValue(lean(null));

    const semNome = await messageCreatedEvent("c1", { ...sender, name: null }, { text: "oi", attachments: [] });
    expect(semNome?.title).toBe("Alguém");

    memberFind.mockReturnValue(lean([{ userId: "u1", name: "Ana" }, { userId: "u2", name: "Bia" }]));
    const comNomeGravado = await messageCreatedEvent("c1", { ...sender, name: null }, { text: "oi", attachments: [] });
    expect(comNomeGravado?.title).toBe("Ana");
  });
});
