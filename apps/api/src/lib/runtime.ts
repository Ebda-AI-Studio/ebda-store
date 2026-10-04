/**
 * Which runtime this code is executing in. The API ships in two shells (R-EBDA-001):
 * Node (Railway/Docker, vitest, scripts) and Cloudflare Workers (`worker.ts`).
 * A few modules pick an implementation by runtime (Redis, queues, realtime, ...);
 * they ask here instead of sniffing on their own.
 *
 * `navigator.userAgent` is `Cloudflare-Workers` on workerd (compat date >= 2022-03-21)
 * and `Node.js/<major>` on Node >= 21.
 */
export const isWorkers: boolean =
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
  'Cloudflare-Workers';
