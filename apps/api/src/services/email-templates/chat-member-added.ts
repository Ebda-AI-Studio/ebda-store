import { escapeHtml } from './_util';

export interface ChatMemberAddedData {
  email: string;
  name: string;
  workspaceName: string;
  /** Where to sign in to Ebda Chat. */
  chatUrl: string;
  /** New accounts only: where to set the first password (the one-time code rides in the URL fragment). */
  setPasswordUrl?: string | null;
}

/** A header value must be one line: drop CR/LF and every other control character (the body is HTML-escaped; the subject is not). */
const oneLine = (v: string): string =>
  // eslint-disable-next-line no-control-regex
  v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

/**
 * An INVITATION to a standalone Ebda Chat workspace (Ruling CHAT-SA-6). Nothing changes until the invitee signs in to Chat as
 * this identity and accepts (7 days). The invitation is bound to the account, not to any link: the only link here is Chat's
 * sign-in. A NEW account also gets a set-password link (its one-time code rides in the fragment) before it can sign in.
 */
export const chatMemberAddedTemplate = {
  subject: {
    en: (d: ChatMemberAddedData) => `You are invited to ${oneLine(d.workspaceName)} on Ebda Chat`,
    ar: (d: ChatMemberAddedData) => `اتدعيت إلى ${oneLine(d.workspaceName)} في ابدأ شات`,
  },
  en: (d: ChatMemberAddedData) => `
    <h2>You are invited to a workspace</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>You are invited to join <strong>${escapeHtml(d.workspaceName)}</strong> on Ebda Chat.</p>
    ${
      d.setPasswordUrl
        ? `<p>First set your password:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.setPasswordUrl)}" class="button">Set your password</a>
    </p>
    <p>That link expires in 24 hours; after that use "Forgot password" on the sign-in page with this email address.</p>`
        : ''
    }
    <p>Then sign in to Ebda Chat with this email address and accept the invitation. Nothing changes until you accept. The invitation is valid for 7 days.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.chatUrl)}" class="button">Open Ebda Chat</a>
    </p>
    <p>If you were not expecting this, you can ignore this email.</p>
  `,
  ar: (d: ChatMemberAddedData) => `
    <h2>اتدعيت إلى مساحة عمل</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>اتدعيت تنضم إلى <strong>${escapeHtml(d.workspaceName)}</strong> في ابدأ شات.</p>
    ${
      d.setPasswordUrl
        ? `<p>الأول اضبط كلمة السر:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.setPasswordUrl)}" class="button">اضبط كلمة السر</a>
    </p>
    <p>اللينك ده بينتهي بعد 24 ساعة، وبعدها استخدم "نسيت كلمة السر" من صفحة تسجيل الدخول بنفس البريد الإلكتروني.</p>`
        : ''
    }
    <p>بعد كده سجّل دخولك في ابدأ شات بنفس البريد الإلكتروني ده ووافق على الدعوة. مفيش حاجة بتتغيّر قبل ما توافق. الدعوة صالحة 7 أيام.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.chatUrl)}" class="button">افتح ابدأ شات</a>
    </p>
    <p>لو مكنتش مستني الرسالة دي، تقدر تتجاهلها.</p>
  `,
};
