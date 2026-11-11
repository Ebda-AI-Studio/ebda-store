// Human alerting (OPS-5 / P04): when an auto incident OPENS or RESOLVES, tell Ahmad on Telegram. This Worker runs on
// Cloudflare, independent of the Mac and the CI guest, so it still alerts when everything local is down.
// No secrets configured = a silent no-op that returns false (the status page keeps working); callers log that.
import type { Snapshot } from './types';

export interface AlertEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHAT_ID?: string;
  /** the AI OS brain mirror (Ruling ESC-AIOS-1 / AIOS-8); token unset = no mirror */
  EBDA_OS_BRAIN_URL?: string;
  EBDA_OS_INGEST_TOKEN?: string;
}

export type SendFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The message for an outcome, or null when nothing opened or resolved. */
export function composeAlert(
  snap: Snapshot,
  outcome: { opened: number[]; resolved: number[] }
): string | null {
  const title = (id: number) =>
    [...snap.active, ...snap.recent].find(i => i.id === id)?.title ?? `incident #${id}`;
  const lines = [
    ...outcome.opened.map(id => `DOWN: ${title(id)}`),
    ...outcome.resolved.map(id => `RECOVERED: ${title(id)}`),
  ];
  return lines.length ? `Ebda Store status\n${lines.join('\n')}\nhttps://status.ebda.app/en` : null;
}

export async function sendTelegram(
  env: AlertEnv,
  text: string,
  send: SendFetch = (u, i) => fetch(u, i)
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ALERT_CHAT_ID) return false;
  try {
    const r = await send(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_ALERT_CHAT_ID, text }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Mirror the same text to the AI OS brain (a Telegram bot cannot read its own messages). Never throws; false = not mirrored. */
export async function mirrorToBrain(
  env: AlertEnv,
  text: string,
  level: 'p1' | 'info',
  send: SendFetch = (u, i) => fetch(u, i)
): Promise<boolean> {
  if (!env.EBDA_OS_INGEST_TOKEN) return false;
  const base = (env.EBDA_OS_BRAIN_URL || 'https://os.ebda.app').replace(/\/$/, '');
  try {
    const r = await send(`${base}/alerts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.EBDA_OS_INGEST_TOKEN}`,
      },
      body: JSON.stringify({
        source: 'ebda-store/status',
        level,
        title: text.split('\n')[1]?.slice(0, 300) || 'Ebda Store status',
        text: text.slice(0, 4096),
        url: 'https://status.ebda.app/en',
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
