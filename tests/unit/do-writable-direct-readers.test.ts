import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ruling CF-NOTIFY-1 (class sweep): a model whose WRITES moved to the Durable Object (`DO_WRITABLE_MODELS`) must have its
 * READERS go through the same repo (`storeDb` / `storeRepo`). A reader that still calls `prisma.<model>.find*` / `tx.<model>...`
 * reads Postgres, which a DO store never writes: a merchant's change is invisible to it (an OFF switch ignored, a stale page).
 *
 * This test derives every direct reader site per model and per file from the source and compares it to the reviewed baseline in
 * `tests/unit/fixtures/do-writable-direct-readers.json`. A NEW direct reader of a DO-writable model, or a model newly made
 * DO-writable, fails here until its reader is routed through the repo (preferred) or the baseline is edited with a reason in the
 * PR (the site is behind a Postgres-only branch: a `storeMoney` / `storeRepo().backend` guard, or an unported job the jobs guard
 * refuses for a DO store). Shrinking the baseline is always allowed: the test asks for it to be updated.
 */
const ROOT = path.resolve(__dirname, '../..');
const lower = (s: string) => s[0].toLowerCase() + s.slice(1);

const models = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/repo/src/rpc/writes.ts'), 'utf8');
  const m = /DO_WRITABLE_MODELS[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(src)!;
  return [...m[1].matchAll(/'([A-Za-z]+)'/g)].map(x => lower(x[1]));
})();

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function derive(): Record<string, Record<string, number>> {
  const re = new RegExp(
    `\\b(?:prisma|tx|c|client)\\.(${models.join('|')})\\.(?:find\\w*|count|aggregate|groupBy)\\(`,
    'g'
  );
  const out: Record<string, Record<string, number>> = {};
  for (const f of walk(path.join(ROOT, 'apps/api/src'))) {
    const rel = path.relative(ROOT, f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
      out[rel] ??= {};
      out[rel][m[1]] = (out[rel][m[1]] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const BASELINE = path.join(__dirname, 'fixtures/do-writable-direct-readers.json');

describe('readers of DO-writable models go through the repo (Ruling CF-NOTIFY-1)', () => {
  it('finds the models and the scan works', () => {
    expect(models.length).toBeGreaterThan(20);
    expect(models).toContain('notificationEventConfig');
  });

  it('the notification config models have no direct reader outside the Postgres branch of their service', () => {
    const d = derive();
    const sites = Object.entries(d).flatMap(([f, m]) =>
      Object.keys(m)
        .filter(k => k === 'notificationConfig' || k === 'notificationEventConfig')
        .map(k => `${f}:${k}`)
    );
    expect(sites.sort()).toEqual([
      'apps/api/src/services/notification-config.service.ts:notificationConfig',
      'apps/api/src/services/notification-dispatcher.service.ts:notificationEventConfig',
    ]);
    // each of those two is the `withStore` Postgres branch next to a `repo.backend === 'do'` branch
    for (const f of ['notification-config.service.ts', 'notification-dispatcher.service.ts'])
      expect(fs.readFileSync(path.join(ROOT, 'apps/api/src/services', f), 'utf8')).toMatch(
        /repo\.backend === 'do'/
      );
  });

  it('no new direct reader of a DO-writable model appeared (baseline of reviewed sites)', () => {
    const now = derive();
    if (process.env.UPDATE_BASELINE === '1')
      fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n');
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as typeof now;
    const added: string[] = [];
    for (const [f, ms] of Object.entries(now))
      for (const [m, n] of Object.entries(ms))
        if (n > (base[f]?.[m] ?? 0)) added.push(`${f}: ${m} x${n} (baseline ${base[f]?.[m] ?? 0})`);
    expect(
      added,
      'route the reader through storeDb / storeRepo, or review it into the baseline'
    ).toEqual([]);
  });
});
