import type { PasskeyNoticeData } from './email-templates/passkey-notice';
import { EmailService } from './email.service';
import { sendPasskeyNoticeEmail } from './platform-mailer';

/**
 * Account-security notice about passkeys. One door for every sender, so the sender identity is decided
 * in one place (Ruling PASSKEY-16, review M8): a merchant's notice comes from the platform (Ebda); a
 * SHOPPER's comes from the sender identity of the store they shop at, because a shopper who has never
 * heard of Ebda would read an "Ebda" security mail as phishing.
 */
export async function sendPasskeyNotice(
  data: PasskeyNoticeData & { storeId?: string | null },
  language: 'en' | 'ar'
): Promise<void> {
  const { storeId, ...notice } = data;
  if (storeId) {
    await EmailService.sendPasskeyNotice(storeId, notice, language);
    return;
  }
  await sendPasskeyNoticeEmail(notice, language);
}
