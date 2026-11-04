import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PERF-TIMEOUTS guard. Every outbound `fetch(` in apps/api/src carries a deadline: use `fetchWithTimeout`
 * (apps/api/src/lib/fetch-timeout.ts) or pass a `signal` / `AbortSignal.timeout` in the init. A call that does neither
 * and is not in ALLOW fails this test. Durable Object stub calls (`stub.fetch(`) and the `fetch(` method
 * declarations are not matched: only a global `fetch(` that follows `await`, `return`, `=`, `=>` or `(`.
 */
const ROOT = path.resolve(__dirname, '../..');
const CALL = /(?:await |return |= |=> |\()(?:globalThis\.)?fetch\(/g;

/** file -> why a bare fetch is fine there. Keep this list short and honest. */
const ALLOW: Record<string, string> = {
  'apps/api/src/lib/fetch-timeout.ts': 'the helper itself; it passes the deadline signal',
  'apps/api/src/lib/carrier-http.ts':
    'stubbed-carrier branch only; the real path is safeFetch, and the wrapper applies timeoutMs',
  'apps/api/src/services/billing/kashier.provider.ts':
    'wrapper aborts through its own AbortController',
  'apps/api/src/services/gold-rate/feed/adapter.ts': 'the cron passes its AbortSignal in the init',
  'apps/api/src/services/payment-providers/fawry.provider.ts':
    'callProvider injects the deadline signal',
  'apps/api/src/services/payment-providers/geidea.provider.ts':
    'callProvider injects the deadline signal',
  'apps/api/src/services/payment-providers/kashier.provider.ts':
    'callProvider injects the deadline signal',
  'apps/api/src/services/payment-providers/paymob.provider.ts':
    'callProvider injects the deadline signal',
};

export function untimedFetches(file: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CALL)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    while (i < src.length && depth) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const call = src.slice(m.index!, i);
    const line = src.slice(0, m.index!).split('\n').length;
    // Skip comments and strings that merely mention fetch(.
    const lineText = src.split('\n')[line - 1]!.trim();
    if (lineText.startsWith('//') || lineText.startsWith('*')) continue;
    if (!/signal|timeout/i.test(call)) out.push(`${file}:${line}`);
  }
  return out;
}

describe('every outbound fetch in apps/api/src has a deadline', () => {
  it('the scanner flags a bare fetch and accepts the timed forms', () => {
    expect(untimedFetches('a.ts', "const r = await fetch('https://x');")).toEqual(['a.ts:1']);
    expect(untimedFetches('a.ts', 'return fetch(u, { headers });')).toEqual(['a.ts:1']);
    expect(
      untimedFetches('a.ts', 'await fetch(u, { signal: AbortSignal.timeout(5000) });')
    ).toEqual([]);
    expect(untimedFetches('a.ts', 'await fetchWithTimeout(u, { timeoutMs: 5000 });')).toEqual([]);
    expect(untimedFetches('a.ts', 'await stub.fetch(new Request(u));')).toEqual([]);
    expect(untimedFetches('a.ts', '  fetch(r: Request): Promise<Response>;')).toEqual([]);
  });

  it('no un-timed global fetch( outside the documented allow-list', () => {
    const files = execFileSync('git', ['ls-files', 'apps/api/src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(f => /\.ts$/.test(f) && !/__tests__|\.test\./.test(f));
    expect(files.length).toBeGreaterThan(300);
    const offenders = files
      .filter(f => !(f in ALLOW))
      .flatMap(f => untimedFetches(f, readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every allow-list entry still exists and still has a bare fetch (no rotting exemptions)', () => {
    for (const f of Object.keys(ALLOW)) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      if (f.endsWith('fetch-timeout.ts')) continue;
      expect(untimedFetches(f, src).length, `${f} no longer needs its exemption`).toBeGreaterThan(
        0
      );
    }
  });
});
