import type { AuthUser } from "../../plugins/auth";
import { ConversationMemberModel } from "../conversations/conversation-member.model";
import { GroupModel } from "../conversations/group.model";
import type { AttachmentType } from "./attachment-rules";

const ATTACHMENT_PREVIEW: Record<AttachmentType, string> & Record<string, string | undefined> = {
  image: "📷 Foto",
  audio: "🎤 Áudio",
  document: "📎 Documento",
};

const PREVIEW_MAX = 140;

/**
 * Evento `message.created` (exchange `raiji.chat`): o backend manda o push para os outros
 * membros. Leva só o necessário para a notificação, nunca o link do anexo.
 */
export async function messageCreatedEvent(
  conversationId: string,
  sender: AuthUser,
  message: { text: string; attachments: { type: string }[] },
) {
  const [members, group] = await Promise.all([
    ConversationMemberModel.find({ conversationId }, "userId name").lean(),
    GroupModel.findOne({ conversationId }, "name").lean(),
  ]);
  const recipientIds = members.map((m) => m.userId).filter((id) => id !== sender.id);
  if (!recipientIds.length) return null;

  const senderName = sender.name ?? members.find((m) => m.userId === sender.id)?.name ?? "Alguém";
  const firstAttachment = message.attachments[0];
  let preview = message.text.trim() || (firstAttachment ? (ATTACHMENT_PREVIEW[firstAttachment.type] ?? "📎 Arquivo") : "Nova mensagem");
  if (preview.length > PREVIEW_MAX) preview = `${preview.slice(0, PREVIEW_MAX - 1)}…`;

  return {
    conversationId,
    senderId: sender.id,
    title: group?.name ?? senderName,
    preview: group ? `${senderName.split(" ")[0]}: ${preview}` : preview,
    recipientIds,
  };
}
