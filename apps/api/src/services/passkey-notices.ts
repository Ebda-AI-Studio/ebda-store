import type { PasskeyNoticeData } from './email-templates/passkey-notice';
import { sendPasskeyNoticeEmail } from './platform-mailer';

/**
 * Account-security notice about passkeys. One door for every sender so the sender identity is decided in
 * one place (PASSKEY-9, refined in PASSKEY-16).
 */
export async function sendPasskeyNotice(
  data: PasskeyNoticeData & { storeId?: string | null },
  language: 'en' | 'ar'
): Promise<void> {
  const { storeId: _storeId, ...notice } = data;
  await sendPasskeyNoticeEmail(notice, language);
}
