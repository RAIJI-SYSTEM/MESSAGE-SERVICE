import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationMemberModel } from "../../src/modules/conversations/conversation-member.model";
import { ConversationModel } from "../../src/modules/conversations/conversation.model";
import { GroupModel } from "../../src/modules/conversations/group.model";
import { messageCreatedEvent } from "../../src/modules/messages/message-events";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";
import { USERS } from "../helpers/app";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

const message = (text: string, attachments: { type: string }[] = []) => ({ text, attachments });

async function directConversation() {
  const conversation = await ConversationModel.create({ type: "direct" });
  await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana", name: "Ana Souza" });
  await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-bruno", name: "Bruno Lima" });
  return conversation;
}

describe("messageCreatedEvent", () => {
  it("não gera evento quando não há outro participante", async () => {
    const conversation = await ConversationModel.create({ type: "direct" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana" });
    await expect(messageCreatedEvent(String(conversation._id), USERS.ana, message("oi"))).resolves.toBeNull();
  });

  it("conversa direta: título é o nome de quem envia e o texto é a prévia", async () => {
    const conversation = await directConversation();
    const event = await messageCreatedEvent(String(conversation._id), USERS.ana, message("  Bom dia!  "));

    expect(event).toEqual({
      conversationId: String(conversation._id),
      senderId: "user-ana",
      title: "Ana Souza",
      preview: "Bom dia!",
      recipientIds: ["user-bruno"],
    });
  });

  it("grupo: usa o nome do grupo e prefixa a prévia com o primeiro nome", async () => {
    const conversation = await ConversationModel.create({ type: "group" });
    await GroupModel.create({ conversationId: conversation._id, name: "Carona Campinas", createdBy: "user-ana" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana", name: "Ana Souza" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-bruno" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-carla" });

    const event = await messageCreatedEvent(String(conversation._id), USERS.ana, message("estou chegando"));
    expect(event).toMatchObject({
      title: "Carona Campinas",
      preview: "Ana: estou chegando",
      recipientIds: ["user-bruno", "user-carla"],
    });
  });

  it("usa o nome gravado no grupo quando o token não tem nome", async () => {
    const conversation = await ConversationModel.create({ type: "group" });
    await GroupModel.create({ conversationId: conversation._id, name: "Grupo", createdBy: "user-ana" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-ana", name: "Ana do grupo" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "user-bruno" });

    const event = await messageCreatedEvent(
      String(conversation._id),
      { id: "user-ana", isAdmin: false, name: null },
      message("oi"),
    );
    expect(event?.preview).toBe("Ana: oi");
  });

  it("cai em 'Alguém' quando não há nome nenhum", async () => {
    const conversation = await directConversation();
    const event = await messageCreatedEvent(
      String(conversation._id),
      { id: "user-desconhecido", isAdmin: false, name: null },
      message("oi"),
    );
    expect(event?.title).toBe("Alguém");
  });

  it("prévia de anexos por tipo", async () => {
    const conversation = await directConversation();
    const cases: [string, string][] = [
      ["image", "📷 Foto"],
      ["audio", "🎤 Áudio"],
      ["document", "📎 Documento"],
      ["video", "📎 Arquivo"],
    ];
    for (const [type, expected] of cases) {
      const event = await messageCreatedEvent(String(conversation._id), USERS.ana, message("", [{ type }]));
      expect(event?.preview).toBe(expected);
    }
  });

  it("sem texto e sem anexo usa 'Nova mensagem'", async () => {
    const conversation = await directConversation();
    const event = await messageCreatedEvent(String(conversation._id), USERS.ana, message(""));
    expect(event?.preview).toBe("Nova mensagem");
  });

  it("trunca prévias longas em 140 caracteres", async () => {
    const conversation = await directConversation();
    const event = await messageCreatedEvent(String(conversation._id), USERS.ana, message("a".repeat(200)));
    expect(event!.preview).toHaveLength(140);
    expect(event!.preview.endsWith("…")).toBe(true);
  });
});
