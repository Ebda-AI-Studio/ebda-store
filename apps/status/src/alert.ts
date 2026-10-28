// Human alerting (OPS-5 / P04): when an auto incident OPENS or RESOLVES, tell Ahmad on Telegram. This Worker runs on
// Cloudflare, independent of the Mac and the CI guest, so it still alerts when everything local is down.
// No secrets configured = a silent no-op that returns false (the status page keeps working); callers log that.
import type { Snapshot } from './types';

export interface AlertEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHAT_ID?: string;
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
