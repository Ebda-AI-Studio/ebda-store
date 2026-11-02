/**
 * Ruling PERF-TIMEOUTS-1 (SCALE-READY #6): every outbound HTTP call from apps/api goes through
 * apps/api/src/lib/fetch-with-timeout.ts, so a stalled third party can never hold a Worker or queue slot forever.
 * AST check (not a grep): any use of the GLOBAL `fetch` identifier or `globalThis.fetch` outside the helper fails.
 * Allowed: `.fetch(` on a Durable Object stub / service binding / class method (internal, not third-party), `typeof fetch`
 * in a type, and method/property NAMES called fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  fetchWithTimeout,
  timedFetch,
  FetchTimeoutError,
  FETCH_TIMEOUT_MS,
} from '../../apps/api/src/lib/fetch-with-timeout';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SRC = path.resolve(__dirname, '../../apps/api/src');
const HELPER = path.join(SRC, 'lib/fetch-with-timeout.ts');

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'test' || name === 'node_modules') continue;
      yield* sourceFiles(p);
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) yield p;
  }
}

/** Positions of global-fetch uses in a source text. */
export function rawFetchUses(text: string, file = 'x.ts'): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === 'fetch') {
      const p = n.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === n && !isGlobalThis(p.expression)) ||
        ((ts.isMethodDeclaration(p) ||
          ts.isMethodSignature(p) ||
          ts.isPropertySignature(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isPropertyAssignment(p)) &&
          p.name === n) ||
        ts.isTypeQueryNode(p) ||
        (ts.isBindingElement(p) && p.propertyName === n) ||
        (ts.isShorthandPropertyAssignment(p) && false);
      if (!isName) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
        hits.push(`${file}:${line + 1}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}
const isGlobalThis = (e: ts.Expression) => ts.isIdentifier(e) && e.text === 'globalThis';

describe('apps/api has no raw outbound fetch (PERF-TIMEOUTS-1)', () => {
  it('scans real source (not an empty-set pass)', () => {
    expect([...sourceFiles(SRC)].length).toBeGreaterThan(300);
  });

  it('the detector flags a raw call, a raw reference and globalThis.fetch, and spares bindings and types', () => {
    expect(rawFetchUses("await fetch('https://x')")).toHaveLength(1);
    expect(rawFetchUses('const f = deps.fetchImpl ?? fetch;')).toHaveLength(1);
    expect(rawFetchUses('globalThis.fetch(u, i)')).toHaveLength(1);
    expect(
      rawFetchUses("binding.fetch('/x'); stub.fetch(req); const t: typeof fetch = a;")
    ).toEqual([]);
    expect(
      rawFetchUses('class A { async fetch(r: Request) {} } interface B { fetch(): void }')
    ).toEqual([]);
  });

  it('no file under apps/api/src calls the global fetch outside the helper', () => {
    const hits = [...sourceFiles(SRC)]
      .filter(f => f !== HELPER)
      .flatMap(f => rawFetchUses(readFileSync(f, 'utf8'), path.relative(SRC, f)));
    expect(hits).toEqual([]);
  });
});

describe('fetchWithTimeout', () => {
  /** A transport that never answers but honours its signal, like the real fetch. */
  const hang = vi.fn(
    (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
      })
  ) as unknown as typeof fetch;

  it('class defaults: payment 10 s, ai 30 s, everything else 8 s', () => {
    expect(FETCH_TIMEOUT_MS).toEqual({ payment: 10_000, ai: 30_000, default: 8_000 });
  });

  it('a stalled upstream throws a typed TimeoutError carrying the label and no URL', async () => {
    const err = await fetchWithTimeout(
      'https://api.example.com/charge?token=SECRET&phone=+201001234567',
      { method: 'POST', body: 'card=4242' },
      { label: 'paymob.charge', timeoutMs: 20 },
      hang
    ).catch(e => e);
    expect(err).toBeInstanceOf(FetchTimeoutError);
    expect(err.name).toBe('TimeoutError');
    expect(err.label).toBe('paymob.charge');
    expect(err.message).toBe('paymob.charge timed out after 20ms');
    expect(JSON.stringify(err.message)).not.toMatch(/SECRET|4242|201001234567|example\.com/);
  });

  it('passes a prompt answer through untouched', async () => {
    const ok = (async () => new Response('ok', { status: 201 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout('https://x.test', undefined, { label: 't' }, ok);
    expect(res.status).toBe(201);
  });

  it("the caller's own abort still wins and is not reported as a timeout", async () => {
    const ctl = new AbortController();
    const p = fetchWithTimeout(
      'https://x.test',
      { signal: ctl.signal },
      { label: 't', timeoutMs: 5000 },
      hang
    );
    ctl.abort(new Error('caller gave up'));
    const err = await p.catch(e => e);
    expect(err).not.toBeInstanceOf(FetchTimeoutError);
    expect(err.message).toBe('caller gave up');
  });

  it('a non-timeout failure (network error) propagates unchanged', async () => {
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      fetchWithTimeout('https://x.test', undefined, { label: 't' }, boom)
    ).rejects.toThrow('fetch failed');
  });

  it('timedFetch bakes the label and class in', async () => {
    const f = timedFetch('onesignal.send', 'default', 15);
    const g = vi.spyOn(globalThis, 'fetch').mockImplementation(hang);
    await expect(f('https://x.test')).rejects.toBeInstanceOf(FetchTimeoutError);
    g.mockRestore();
  });
});
