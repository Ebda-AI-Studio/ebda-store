/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Ruling DEMO-SEED-DO-1: the demo-store home seed on a StoreDO, Postgres gone. Drives the REAL seed logic
 * (scripts/storedemo/seed-home-do-lib.mjs + the Lamma home builder the old seed used) against the operator channel
 * `/api/v1/internal/demo-home/:slug` on local workerd + local D1: bearer refused, a non-demo store refused, dry run writes
 * nothing, --apply publishes and reads back, a second run is a no-op (idempotent), and nothing reaches Postgres.
 *
 * Run: npm run -w apps/api cf:dry-run && npx vitest run --config vitest.workers.config.mts workers-test/demo-home.test.ts
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { httpClient, seedOne } from '../../../scripts/storedemo/seed-home-do-lib.mjs';
import { buildLammaHome } from '../../../scripts/storedemo/lamma-home.mjs';

type DoAnswer = { ok: true; json: string } | { ok: false; code: string; message?: string };
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  E2E_DB: string;
  DEMO_SEED_TOKEN: string;
  PLATFORM_DB: {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: {
    idFromName(n: string): unknown;
    get(id: unknown): { applySettings(storeId: string, fieldsJson: string): Promise<DoAnswer> };
  };
};

const ORIGIN = 'https://api.ebda.app';
const fetchApi = (u: string, i?: RequestInit) => e.API.fetch(u, i);
const http = httpClient(ORIGIN, e.DEMO_SEED_TOKEN, fetchApi as typeof fetch);
const assets = { img: (f: string) => `https://media.ebda.app/demo/lamma/${f}`, video: null };
const DEMO = 'lamma-showroom-t'; // `storedemo*` slugs are reserved for the real showrooms
const REAL = 'real-merchant-t';
const spec = { slug: DEMO, buildHome: buildLammaHome };
const demoSlugs = new Set([DEMO, REAL]); // the client allow-list is bypassed on purpose for REAL: the Worker must refuse it

async function pgReaches(reset = false): Promise<Array<{ label: string }>> {
  const r = await e.API.fetch(`${ORIGIN}/__dev/pg-reaches${reset ? '?reset=1' : ''}`);
  return ((await r.json()) as { reaches: Array<{ label: string }> }).reaches;
}
async function createStore(slug: string, demo: boolean): Promise<string> {
  const r = await e.API.fetch(`${ORIGIN}/__dev/create-store`, {
    method: 'POST',
    body: JSON.stringify({ ownerId: `owner-${slug}`, name: slug, slug, operator: true }),
  });
  expect(r.status).toBe(200);
  const id = ((await r.json()) as { id: string }).id;
  if (demo) {
    // is_demo is set at provisioning: authoritative in D1 `stores`, copied to the DO's store_profile (Ruling CF-WRITES-2).
    await e.PLATFORM_DB.prepare('UPDATE stores SET is_demo = 1 WHERE id = ?1').bind(id).run();
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName(id));
    const m = await stub.applySettings(id, JSON.stringify({ isDemo: true }));
    expect(m.ok, JSON.stringify(m)).toBe(true);
  }
  return id;
}

describe.skipIf(e.E2E_DB === '1')('demo-home seed on a DO store, Postgres gone', () => {
  let demoId = '';

  it('fixture: a demo store and a real merchant store on their DOs', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      )
        .bind(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits))
        .run();
    demoId = await createStore(DEMO, true);
    await createStore(REAL, false);
    await pgReaches(true);
  });

  it('a missing or wrong bearer is refused before anything is read', async () => {
    const none = await e.API.fetch(`${ORIGIN}/api/v1/internal/demo-home/${DEMO}`);
    expect(none.status).toBe(403);
    const bad = httpClient(ORIGIN, 'x'.repeat(40), fetchApi as typeof fetch);
    await expect(bad('GET', `/api/v1/internal/demo-home/${DEMO}`)).rejects.toThrow(/403/);
  });

  it('a store that is not is_demo is refused (403 NOT_DEMO), for reads and writes', async () => {
    await expect(http('GET', `/api/v1/internal/demo-home/${REAL}`)).rejects.toThrow(/NOT_DEMO/);
    await expect(
      http('PUT', `/api/v1/internal/demo-home/${REAL}`, { baseRev: 0, definition: {} })
    ).rejects.toThrow(/NOT_DEMO/);
    await expect(http('GET', `/api/v1/internal/demo-home/no-such-store`)).rejects.toThrow(/404/);
  });

  it('dry run reports the change and writes nothing', async () => {
    const before = await http('GET', `/api/v1/internal/demo-home/${DEMO}`);
    expect(before.storeId).toBe(demoId);
    const r = await seedOne(spec, { http, apply: false, assets, demoSlugs });
    expect(r.status).toBe('would-change');
    const after = await http('GET', `/api/v1/internal/demo-home/${DEMO}`);
    expect(after.rev).toBe(before.rev);
    expect(after.source).toBe(before.source);
  });

  it('--apply publishes the built home and reads it back; a second run is a no-op', async () => {
    const r = await seedOne(spec, { http, apply: true, assets, demoSlugs });
    expect(r.status, r.line).toBe('published');
    const state = await http('GET', `/api/v1/internal/demo-home/${DEMO}`);
    expect(state.source).toBe('published');
    const types = (state.definition.sections as Array<{ type: string; hidden?: boolean }>)
      .filter(s => !s.hidden)
      .map(s => s.type);
    expect(types).toContain('maker-profile');
    const again = await seedOne(spec, { http, apply: true, assets, demoSlugs });
    expect(again.status).toBe('unchanged');
    const still = await http('GET', `/api/v1/internal/demo-home/${DEMO}`);
    expect(still.rev).toBe(state.rev);
  });

  it('nothing reached the Postgres client', async () => {
    expect((await pgReaches()).map(x => x.label)).toEqual([]);
  });
});
