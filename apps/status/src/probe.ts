import { DEFAULT_TIMEOUT_MS } from './config';
import type { ComponentConfig, ProbeResult } from './types';

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_BODY_BYTES = 64 * 1024;

/**
 * One HTTP probe with a hard deadline. A probe is a SUCCESS only if the response status equals
 * `expectStatus` and (when configured) the body matches `expectBody`, all within `timeoutMs`.
 * Anything else, including a timeout, a network error or a hung body read, is a failure. The
 * deadline is enforced with a race, not only with AbortSignal, so a fetch that ignores the
 * signal still cannot stall the cron run.
 */
export async function probe(
  c: ComponentConfig,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  timeoutMs: number = c.timeoutMs ?? DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const result = (r: Omit<ProbeResult, 'id' | 'latencyMs'>): ProbeResult => ({
    id: c.id,
    latencyMs: Date.now() - started,
    ...r,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeResult>(resolve => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(result({ ok: false, status: null, error: `timeout after ${timeoutMs}ms` }));
    }, timeoutMs);
  });

  const run = (async (): Promise<ProbeResult> => {
    try {
      const res = await fetcher(c.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'EbdaStatusProbe/1.0', 'cache-control': 'no-cache' },
      });
      if (res.status !== c.expectStatus) {
        void res.body?.cancel().catch(() => undefined);
        return result({
          ok: false,
          status: res.status,
          error: `status ${res.status}, expected ${c.expectStatus}`,
        });
      }
      if (c.expectBody) {
        const text = (await res.text()).slice(0, MAX_BODY_BYTES);
        if (!new RegExp(c.expectBody, 'i').test(text)) {
          return result({ ok: false, status: res.status, error: 'body did not match' });
        }
      } else {
        void res.body?.cancel().catch(() => undefined);
      }
      return result({ ok: true, status: res.status, error: null });
    } catch (e) {
      const name = e instanceof Error ? e.name : 'Error';
      return result({ ok: false, status: null, error: `fetch failed (${name})` });
    }
  })();

  try {
    return await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every component concurrently. */
export function probeAll(
  components: readonly ComponentConfig[],
  fetcher?: Fetcher,
  timeoutMs?: number
): Promise<ProbeResult[]> {
  return Promise.all(components.map(c => probe(c, fetcher, timeoutMs)));
}

/**
 * The Arabic (Egyptian) wording of a probe error for the public incident text (content audit C7): the English
 * `error` strings above stay for logs and the English page; the Arabic page never shows them raw.
 */
export function probeErrorAr(error: string | null | undefined): string {
  if (!error) return 'خطأ مش معروف';
  const timeout = /^timeout after (\d+)ms$/.exec(error);
  if (timeout) return `مفيش رد خلال ${Math.round(Number(timeout[1]) / 1000)} ثواني`;
  const status = /^status (\d+), expected (\d+)$/.exec(error);
  if (status) return `رجّع كود ${status[1]} بدل ${status[2]}`;
  if (error === 'body did not match') return 'الصفحة رجعت من غير المحتوى المتوقع';
  if (error.startsWith('fetch failed')) return 'الاتصال فشل';
  return 'خطأ مش معروف';
}
