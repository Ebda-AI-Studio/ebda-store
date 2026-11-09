/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * LAUNCH-RL: the publicSearchLimiter key is PER CLIENT on workerd. The Worker overwrites X-Forwarded-For with
 * CF-Connecting-IP (worker.ts withTrustedClientIp) and Express runs `trust proxy` 1, so req.ip is the Cloudflare-seen client.
 * If the key ever collapsed to one value (127.0.0.1, an edge IP, undefined) the 60/min search limit would be GLOBAL.
 *
 *   npx vitest run --config vitest.workers.config.mts workers-test/search-limiter-key.test.ts   (after `npm run cf:dry-run`)
 */
import { describe, expect, it } from 'vitest';
import { api } from './helpers';

// A non-UUID store id is a 400 from the handler, after the limiter: no database is involved.
const suggest = (ip: string | null) =>
  api.fetch('https://api.ebda.app/api/v1/public/not-a-uuid/search/suggest?q=a', {
    headers: ip ? { 'cf-connecting-ip': ip } : {},
  });

describe('publicSearchLimiter keys on the client IP on workerd', () => {
  it('429s one client at N+1 while another client still gets through', async () => {
    const a = `203.0.113.${100 + (Date.now() % 100)}`;
    const b = '198.51.100.7';
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await suggest(a)).status);
    expect(statuses.slice(0, 60).every(s => s === 400)).toBe(true);
    expect(statuses[60]).toBe(429);
    const limited = await suggest(a);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    // a different client is NOT affected: the bucket is not global
    expect((await suggest(b)).status).toBe(400);
  });
});
