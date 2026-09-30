/**
 * scripts/set-sale-badge-legacy-corner.mjs (#1998, owner 2026-09-30) — the
 * one-off that keeps pecannbee on the legacy sale-badge corner BEFORE the new
 * default deploys. Driven against a local stand-in for the two API routes it
 * uses, with the real route's semantics: `PUT /stores/:id/theme` shallow-merges
 * the body into the stored theme (StoreService.updateTheme), and the public
 * store GET returns the theme verbatim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const SCRIPT = resolve(__dirname, '../../scripts/set-sale-badge-legacy-corner.mjs');
const STORE_ID = '11111111-2222-3333-4444-555555555555';

let server: http.Server;
let base: string;
let theme: Record<string, unknown>;
let puts: Array<{ auth?: string; body: unknown }>;

beforeEach(async () => {
  theme = { primaryColor: '#ff6e01', showQuickAdd: true, dividers: { enabled: true } };
  puts = [];
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/v1/public/stores/pecannbee') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          success: true,
          data: { store: { id: STORE_ID, slug: 'pecannbee', theme } },
        })
      );
      return;
    }
    if (req.method === 'PUT' && url.pathname === `/api/v1/stores/${STORE_ID}/theme`) {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        puts.push({ auth: req.headers.authorization, body });
        theme = { ...theme, ...body }; // StoreService.updateTheme: shallow merge
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>(r => server.close(() => r())));

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string }>(done => {
    execFile(
      process.execPath,
      [SCRIPT, '--api', base, '--store', 'pecannbee', ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr })
    );
  });
}

describe('set-sale-badge-legacy-corner script', () => {
  it('dry run (default) writes nothing and prints the exact shallow-merge body', async () => {
    const r = await run([], { FWB_ADMIN_TOKEN: 'tok' });
    expect(r.code).toBe(0);
    expect(puts).toHaveLength(0);
    expect(r.out).toContain('DRY-RUN');
    expect(r.out).toContain('{"saleBadgeLegacyCorner":true}');
  });

  it('--apply sends ONLY the flag, with the bearer token, and every other theme key survives', async () => {
    const r = await run(['--apply'], { FWB_ADMIN_TOKEN: 'secret-token' });
    expect(r.code).toBe(0);
    expect(puts).toEqual([{ auth: 'Bearer secret-token', body: { saleBadgeLegacyCorner: true } }]);
    expect(theme).toEqual({
      primaryColor: '#ff6e01',
      showQuickAdd: true,
      dividers: { enabled: true },
      saleBadgeLegacyCorner: true,
    });
    expect(r.out).toContain('Verified at origin');
    expect(r.out).not.toContain('secret-token'); // never printed
  });

  it('is idempotent — a second run is a no-op', async () => {
    await run(['--apply'], { FWB_ADMIN_TOKEN: 't' });
    const again = await run(['--apply'], { FWB_ADMIN_TOKEN: 't' });
    expect(again.code).toBe(0);
    expect(again.out).toContain('Already set');
    expect(puts).toHaveLength(1);
  });

  it('refuses --apply without a token and writes nothing', async () => {
    const r = await run(['--apply']);
    expect(r.code).toBe(2);
    expect(puts).toHaveLength(0);
  });
});
