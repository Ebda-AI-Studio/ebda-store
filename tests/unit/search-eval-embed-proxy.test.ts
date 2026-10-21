// Search eval embed proxy (Task 13 review M4): a localhost Worker that spends Workers AI on the
// Whisky account. A webpage in the developer's browser can fire a "simple" cross-origin POST
// (text/plain, no custom headers) at 127.0.0.1, so the proxy demands application/json (forces a
// CORS preflight it never answers) AND a per-run shared secret header. No network: fake AI binding.
import { describe, it, expect } from 'vitest';
import proxy from '../search-eval/embed-proxy/worker';
import { EVAL_SECRET_HEADER } from '../search-eval/embed-proxy/shared';

const SECRET = 'a'.repeat(48);
function env() {
  const calls: string[][] = [];
  return {
    calls,
    env: {
      EVAL_PROXY_SECRET: SECRET,
      AI: {
        async run(_m: string, input: { text: string[] }) {
          calls.push(input.text);
          return { data: input.text.map(() => [0]) };
        },
      },
    },
  };
}
const post = (body: string, headers: Record<string, string>) =>
  new Request('http://127.0.0.1:8799/', { method: 'POST', body, headers });
const JSON_BODY = JSON.stringify({ text: ['كوتشي'] });

describe('embed proxy', () => {
  it('embeds for application/json with the right secret', async () => {
    const e = env();
    const res = await proxy.fetch(
      post(JSON_BODY, { 'content-type': 'application/json', [EVAL_SECRET_HEADER]: SECRET }),
      e.env
    );
    expect(res.status).toBe(200);
    expect(e.calls).toEqual([['كوتشي']]);
  });

  it('refuses a simple cross-origin POST (text/plain), even with a JSON body', async () => {
    const e = env();
    const res = await proxy.fetch(
      post(JSON_BODY, { 'content-type': 'text/plain', [EVAL_SECRET_HEADER]: SECRET }),
      e.env
    );
    expect(res.status).toBe(415);
    expect(e.calls).toEqual([]);
  });

  it('refuses a missing or wrong secret', async () => {
    for (const h of [{}, { [EVAL_SECRET_HEADER]: 'b'.repeat(48) }]) {
      const e = env();
      const res = await proxy.fetch(
        post(JSON_BODY, { 'content-type': 'application/json', ...h }),
        e.env
      );
      expect(res.status).toBe(403);
      expect(e.calls).toEqual([]);
    }
  });

  it('refuses every request when the proxy was started without a strong secret', async () => {
    for (const s of [undefined, '', 'short']) {
      const e = env();
      const res = await proxy.fetch(
        post(JSON_BODY, { 'content-type': 'application/json', [EVAL_SECRET_HEADER]: s ?? '' }),
        { ...e.env, EVAL_PROXY_SECRET: s }
      );
      expect(res.status).toBe(503);
      expect(e.calls).toEqual([]);
    }
  });

  it('wrangler.jsonc binds loopback by default', async () => {
    const { readFileSync } = await import('node:fs');
    const cfg = readFileSync(
      new URL('../search-eval/embed-proxy/wrangler.jsonc', import.meta.url),
      'utf8'
    );
    expect(cfg).toMatch(/"ip":\s*"127\.0\.0\.1"/);
  });
});
