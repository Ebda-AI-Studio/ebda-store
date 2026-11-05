import { describe, expect, it } from 'vitest';
import { jobDataClass } from '../../apps/api/src/lib/jobs/job-data';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ruling CF-NOTIFY-1 (class sweep): a model whose WRITES moved to the Durable Object (`DO_WRITABLE_MODELS`) must have its
 * READERS go through the same repo (`storeDb` / `storeRepo`). A reader that still calls `prisma.<model>.find*` / `tx.<model>...`
 * reads Postgres, which a DO store never writes: a merchant's change is invisible to it (an OFF switch ignored, a stale page).
 *
 * This test derives every direct reader site per model and per file from the source and compares it, EXACTLY, to the reviewed
 * baseline in `tests/unit/fixtures/do-writable-direct-readers.json` (Ruling CF-R6B-1). Every baseline entry is a site that
 * legitimately stays on Postgres, with a `kind` and a `reason` the test checks against the code: `job-unported` (every job id is
 * `unported`, so the jobs guard refuses a DO store), `pg-branch` (the file has the storeMoney / storeStock / storeRepo early return
 * that serves a DO store), `pg-only-flow` (named in docs/cf/not-on-do.json `postgresOnly`, so the flip gate stays closed),
 * `platform` (a platform / cross-store read). `dead` lists methods with no caller. A site whose `tx` IS the repo client carries a
 * `repo-tx` comment. A NEW direct reader, or a model newly made DO-writable, fails until it is routed through
 * `storeDb` / `storeRepo` (preferred) or reviewed into the baseline with a kind and a reason.
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
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return; // prose that quotes a call is not a call
      for (const m of line.matchAll(re)) {
        if (lines.slice(Math.max(0, i - 1), i + 4).some(l => l.includes('repo-tx'))) continue;
        out[rel] ??= {};
        out[rel][m[1]] = (out[rel][m[1]] ?? 0) + 1;
      }
    });
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

  type Entry = {
    kind: 'job-unported' | 'pg-branch' | 'pg-only-flow' | 'platform';
    reason: string;
    models: Record<string, number>;
    jobs?: string[];
    guardFile?: string;
  };
  type Dead = { models: Record<string, number>; methods: string[]; reason: string };
  const fixture = () =>
    JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as {
      dead: Record<string, Dead>;
      baseline: Record<string, Entry>;
    };
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('the baseline is EXACTLY the set of remaining direct readers (no new one, none left stale)', () => {
    const now = derive();
    const { baseline, dead } = fixture();
    const expected: Record<string, Record<string, number>> = {};
    for (const [f, e] of Object.entries(baseline)) expected[f] = { ...e.models };
    for (const [f, d] of Object.entries(dead))
      for (const [m, n] of Object.entries(d.models)) {
        expected[f] ??= {};
        expected[f][m] = (expected[f][m] ?? 0) + n;
      }
    const sorted = (o: Record<string, Record<string, number>>) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    expect(
      sorted(now),
      'route a new reader through storeDb / storeRepo, or review it into the baseline with a kind and a reason'
    ).toEqual(sorted(expected));
  });

  it('every baseline entry carries a real reason and its kind holds against the code', () => {
    const doc = read('docs/cf/not-on-do.json');
    const { baseline } = fixture();
    expect(Object.keys(baseline).length).toBeGreaterThan(0);
    for (const [f, e] of Object.entries(baseline)) {
      expect(e.reason.length, f).toBeGreaterThan(40);
      if (e.kind === 'job-unported') {
        expect(e.jobs?.length, f).toBeGreaterThan(0);
        for (const id of e.jobs!) {
          expect(jobDataClass(id), `${f}: job ${id} must be unported (refused for DO stores)`).toBe(
            'unported'
          );
          const reg = walk(path.join(ROOT, 'apps/api/src')).some(g =>
            fs.readFileSync(g, 'utf8').includes(`id: '${id}'`)
          );
          expect(reg, `${f}: job ${id} is not registered anywhere`).toBe(true);
        }
      } else if (e.kind === 'pg-branch') {
        expect(read(e.guardFile ?? f), f).toMatch(/storeMoney\(|storeStock\(|storeRepo\(/);
      } else if (e.kind === 'pg-only-flow') {
        expect(
          doc.includes(path.basename(f)) || /accounting flows|barcode scan stock flows/.test(doc),
          `${f}: a pg-only flow must be listed in docs/cf/not-on-do.json postgresOnly`
        ).toBe(true);
      } else expect(e.kind, f).toBe('platform');
    }
  });

  it('the dead methods really have no caller', () => {
    const { dead } = fixture();
    const all = [...walk(path.join(ROOT, 'apps')), ...walk(path.join(ROOT, 'packages'))];
    for (const [f, d] of Object.entries(dead))
      for (const m of d.methods) {
        const callers = all.flatMap(g =>
          fs
            .readFileSync(g, 'utf8')
            .split('\n')
            .filter(l => new RegExp(`\\b${m}\\(`).test(l) && !/static async|^\s*(\*|\/\/)/.test(l))
            .map(l => `${g}: ${l.trim()}`)
        );
        expect(callers, `${f}.${m}`).toEqual([]);
      }
  });
});
