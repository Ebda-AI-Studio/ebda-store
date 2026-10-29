/**
 * One-time codes over WhatsApp (Ruling ID-WA-OTP-1): the password-reset code that was just issued and mailed is ALSO sent to the account's own phone
 * through the ebda-wa Worker's `WhatsAppOtp.sendOtp(storeId, phone, code)` RPC. A channel BESIDE the email, never instead of it.
 *
 * Fails closed, and never gets in the way of the email:
 *  - no `WHATSAPP_OTP` binding, no phone on file, an unverified address or an inactive account = no attempt at all;
 *  - only a store the user OWNS may send (the sender is that store's own connected number; WhatsApp refuses the shared platform number);
 *  - ebda-wa decides whether the store has switched `otpViaWhatsApp` on, allows the country and enforces its toll-fraud limits;
 *  - every failure (a refusal, a throw, a timeout, the directory down) is swallowed after one log line holding the REASON only;
 *    the code and the phone number are never logged.
 */
import type { UserRow } from './data';

type Reason = string;
const TIMEOUT_MS = 4_000;
const MAX_STORES = 3;
/** Refusals that mean "THIS store cannot send"; the next store the user owns may. Anything else (rate limit, bad phone, country, a send error, outage) stops the loop. */
const TRY_NEXT: ReadonlySet<Reason> = new Set([
  'disabled',
  'not_found',
  'no_number',
  'template_unavailable',
]);

const timeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
  ]);

export async function sendCodeOverWhatsApp(
  env: Pick<Cloudflare.Env, 'WHATSAPP_OTP' | 'STORE_DIRECTORY'>,
  user: Pick<UserRow, 'id' | 'phone' | 'email_verified' | 'status'>,
  code: string
): Promise<'sent' | 'skipped' | 'failed'> {
  const rpc = env.WHATSAPP_OTP;
  const phone = user.phone?.trim();
  if (!rpc || !env.STORE_DIRECTORY || !phone || !user.email_verified || user.status !== 'active')
    return 'skipped';
  try {
    const owned = (await timeout(env.STORE_DIRECTORY.storesForUser(user.id)))
      .filter(s => s.role === 'owner')
      .slice(0, MAX_STORES);
    if (!owned.length) return 'skipped';
    let last: Reason = 'no_store';
    for (const store of owned) {
      const r = await timeout(rpc.sendOtp(store.id, phone, code));
      if (r.ok) return 'sent';
      last = r.reason;
      if (!TRY_NEXT.has(r.reason)) break;
    }
    console.error(JSON.stringify({ msg: 'whatsapp otp not sent', reason: last }));
    return 'failed';
  } catch (e) {
    console.error(JSON.stringify({ msg: 'whatsapp otp failed', error: (e as Error).message }));
    return 'failed';
  }
}
