/**
 * Password-reset codes over WhatsApp (Rulings ID-WA-OTP-1 and WA-OTP-SENDER-1): the code that was just issued and mailed is ALSO sent to the account's
 * own phone through the ebda-wa Worker's `PlatformOtp.sendCode(phone, code)`. A channel BESIDE the email, never instead of it.
 *
 * The sender is the PLATFORM number and nothing else. There is deliberately no store id in this call and no per-store loop: a message sent from a store's
 * number lands in that store's inbox history, where every staff member of the store can read the owner's code (an account-takeover path, found by the
 * security review 2026-10-29). Until the platform number exists the channel is OFF: `WHATSAPP_OTP_ENABLED` is not "true" (the default) = no attempt at all.
 *
 * Fails closed, and never gets in the way of the email: flag off, no binding, no phone, an unverified or inactive account = no attempt. Every failure
 * (a refusal, a throw, a timeout) is swallowed after one log line holding the REASON only; the code and the phone number are never logged.
 */
import type { UserRow } from './data';

const TIMEOUT_MS = 4_000;

const timeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
  ]);

export async function sendCodeOverWhatsApp(
  env: Pick<Cloudflare.Env, 'WHATSAPP_OTP' | 'WHATSAPP_OTP_ENABLED'>,
  user: Pick<UserRow, 'phone' | 'email_verified' | 'status'>,
  code: string
): Promise<'sent' | 'skipped' | 'failed'> {
  const rpc = env.WHATSAPP_OTP;
  const phone = user.phone?.trim();
  if (
    env.WHATSAPP_OTP_ENABLED !== 'true' ||
    !rpc ||
    !phone ||
    !user.email_verified ||
    user.status !== 'active'
  )
    return 'skipped';
  try {
    const r = await timeout(rpc.sendCode(phone, code));
    if (r.ok) return 'sent';
    console.error(JSON.stringify({ msg: 'whatsapp otp not sent', reason: r.reason }));
    return 'failed';
  } catch (e) {
    console.error(JSON.stringify({ msg: 'whatsapp otp failed', error: (e as Error).message }));
    return 'failed';
  }
}
