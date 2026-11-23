import { escapeHtml } from './_util';

export interface ChatMemberAddedData {
  email: string;
  name: string;
  workspaceName: string;
  /** Where to sign in to Ebda Chat. */
  chatUrl: string;
}

/** An existing identity was added to a standalone Ebda Chat workspace (Ruling CHAT-SA-6). No code: they sign in as usual. */
export const chatMemberAddedTemplate = {
  subject: {
    en: (d: ChatMemberAddedData) => `You were added to ${d.workspaceName} on Ebda Chat`,
    ar: (d: ChatMemberAddedData) => `اتضفت إلى ${d.workspaceName} في ابدأ شات`,
  },
  en: (d: ChatMemberAddedData) => `
    <h2>You were added to a workspace</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>You were added to <strong>${escapeHtml(d.workspaceName)}</strong> on Ebda Chat. Sign in with this email address to open it.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.chatUrl)}" class="button">Open Ebda Chat</a>
    </p>
    <p>If you were not expecting this, you can ignore this email.</p>
  `,
  ar: (d: ChatMemberAddedData) => `
    <h2>اتضفت إلى مساحة عمل</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>اتضفت إلى <strong>${escapeHtml(d.workspaceName)}</strong> في ابدأ شات. سجّل دخولك بنفس البريد الإلكتروني ده عشان تفتحها.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.chatUrl)}" class="button">افتح ابدأ شات</a>
    </p>
    <p>لو مكنتش مستني الرسالة دي، تقدر تتجاهلها.</p>
  `,
};
