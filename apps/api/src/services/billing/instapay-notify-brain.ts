/**
 * Store -> OS brain bridge for the InstaPay auto-confirm digest and "waiting on you" notices (Ruling INSTAPAY-AUTO-1, foundation
 * `instapay-digest` v0.3.0). The brain is the single consumer of @EbdaAIStudiobot: this Worker never talks to Telegram itself.
 *
 * `notifyBrain` returns true ONLY when the brain answered 2xx AND `sent: true` (INSTAPAY-CLEAN-1: a payment is "clean" only after it
 * appeared in a digest actually delivered to Ahmad, so `digestSentAt` is stamped from this answer and nowhere else). Any other outcome
 * (no config, network error, 4xx/5xx, `sent:false` for an empty digest, a daily cap 429) is false and the caller keeps the rows for the next run.
 */
import { signBridge, type DigestItem } from '@ebda/shared';
import logger from '../../lib/logger';
import { MIN_BRIDGE_SECRET } from '../../lib/instapay-bridge-env';

type WaitingItem = DigestItem & { reasons: string[] };
const TIMEOUT_MS = 8000;

export async function notifyBrain(
  kind: 'digest' | 'waiting',
  items: Array<DigestItem | WaitingItem>,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<boolean> {
  const secret = env.INSTAPAY_BRIDGE_SECRET ?? '';
  const url = (env.BRAIN_BRIDGE_URL ?? '').trim();
  if (secret.length < MIN_BRIDGE_SECRET || !url || items.length === 0) return false;
  const body = JSON.stringify({ kind, items });
  const sig = await signBridge(secret, body, now, 'notify');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Bridge-Product': 'store',
        'X-Bridge-Ts': String(now),
        'X-Bridge-Sig': sig,
      },
      body,
      signal: ctl.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status, kind }, '[instapay-auto] brain refused the notice');
      return false;
    }
    const j = (await res.json().catch(() => null)) as { sent?: unknown } | null;
    return j?.sent === true;
  } catch (err) {
    logger.warn({ err, kind }, '[instapay-auto] brain unreachable');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
