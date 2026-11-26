/**
 * RESOLVE-SWR-1 guard: a writer of a NEVER-stale store column must clear the read caches in EVERY layer.
 *
 * The public store payload (`GET /public/store/resolve`) is cached with a stale-while-revalidate window, and the store
 * directory entry it is built from is cached too. status / suspension, plan (-> enabledFeatures), slug, domain and deletion
 * are NEVER-stale: they are cleared by EVENT, by `bustStoreCaches` (services/store.service.ts), which
 *   (a) bumps the generation and deletes the KV entries (`invalidateStoreDirectory` + `invalidateCached`),
 *   (b) drops the per-isolate memory copy (`invalidateCached` clears the in-memory layer; `bustCorsCache` the CORS trust), and
 *   (c) purges the storefront data cache and the edge HTML by slug / domain tag (`revalidateStorefront`).
 * A writer that skips it leaves a stale payload behind (a suspended store still browsable; a downgraded plan still listing paid
 * features) for as long as the window lasts. This scan fails when a source file writes one of those columns through a Store
 * write funnel and neither calls the bust nor is listed below with the file that does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../apps/api/src');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules') continue;
      walk(p, out);
    } else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

// A write funnel for the Store row: the routed helpers, the Prisma delegate, or raw SQL on `stores`.
const WRITE =
  /\b(storeUpdate|storeUpdateMany|updateStoreThrough|storeUpdateOnDo)\(|\.store\.(update|updateMany|upsert|delete|deleteMany)\(|(UPDATE|DELETE FROM|INSERT INTO)\s+(public\.)?"?stores"?[\s(]/;
// A NEVER-stale column inside the call's data (object key) or a raw SET clause.
const NEVER_STALE =
  /\b(status|slug|domain|domainStatus|deletedAt|billingSuspendedReason|billingSuspendedAt|plan)\s*:|data:\s*\{[^}\n]*\b(status|slug|domain|deletedAt|plan)\b|SET\s+"?(status|slug|plan|domain|deleted_at)"?\s*=/;
const BUST = /\b(bustStoreCaches|invalidateStoreDirectory)\(/;

/**
 * Files that write a NEVER-stale column but clear the caches through ANOTHER file. `via` must really contain the bust (checked).
 * Keep this short: a new entry needs a reason a reviewer can verify.
 */
const DELEGATED: Record<string, { via: string; why: string }> = {
  'services/store-domain.service.ts': {
    via: 'services/domain-claim.service.ts',
    why: 'clearing a domain calls DomainClaimService.afterDomainChanged, which busts',
  },
  'lib/store-directory-sync.ts': {
    via: 'services/store.service.ts',
    why: 'the D1 mirror of a Postgres write that store.service.ts already busted (updateStoreThrough); never a first writer',
  },
  'lib/store-create-do.ts': {
    via: 'lib/store-create-do.ts',
    why: 'a creation: invalidateStoreDirectory runs at the end of createStoreOnDo (no earlier payload to clear)',
  },
};

function sitesOf(src: string): number[] {
  const lines = src.split('\n');
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*(\*|\/\/)/.test(l) || !WRITE.test(l)) return;
    if (NEVER_STALE.test(lines.slice(i, i + 14).join('\n'))) hits.push(i + 1);
  });
  return hits;
}

describe('store write paths clear the read caches (RESOLVE-SWR-1)', () => {
  const files = walk(SRC).map(f => path.relative(SRC, f));
  const writers = files
    .map(rel => ({ rel, sites: sitesOf(read(rel)) }))
    .filter(w => w.sites.length > 0);

  it('the scan finds the known writers (it is not vacuous)', () => {
    const names = writers.map(w => w.rel);
    for (const must of [
      'services/store.service.ts',
      'services/plan.service.ts',
      'services/billing/account.service.ts',
      'services/provisioning.service.ts',
      'services/domain-claim.service.ts',
    ])
      expect(names, `${must} writes a NEVER-stale column`).toContain(must);
  });

  it('every writer calls the bust itself or delegates to a file that does', () => {
    const missing: string[] = [];
    for (const { rel, sites } of writers) {
      if (BUST.test(read(rel))) continue;
      const d = DELEGATED[rel];
      if (d && BUST.test(read(d.via))) continue;
      missing.push(
        `${rel}:${sites.join(',')}: writes status/slug/domain/plan/deleted without bustStoreCaches`
      );
    }
    expect(missing).toEqual([]);
  });

  it('every delegation names a file that really calls the bust', () => {
    for (const [rel, d] of Object.entries(DELEGATED)) {
      expect(files, `${rel} no longer exists: drop its entry`).toContain(rel);
      expect(BUST.test(read(d.via)), `${rel} delegates to ${d.via}, which has no bust`).toBe(true);
    }
  });

  it('the repair paths that write straight into D1 / the plan tier are covered', () => {
    expect(read('lib/store-directory-reconcile.ts')).toMatch(/bustAfterRepair/);
    expect(read('services/billing/subscription-billing.service.ts')).toMatch(
      /bustStoreCaches\(d\.storeId/
    );
  });

  it('every applyPlan call in the billing service is followed by a plan_changed / downgraded effect (billing-notify busts on it)', () => {
    const src = read('services/billing/subscription-billing.service.ts');
    const lines = src.split('\n');
    const bad: number[] = [];
    lines.forEach((l, i) => {
      if (!/\bawait applyPlan\(/.test(l)) return;
      const window = lines.slice(i, i + 20).join('\n');
      if (!/kind: '(plan_changed|downgraded)'/.test(window)) bad.push(i + 1);
    });
    expect(bad, 'applyPlan without a following plan_changed/downgraded effect').toEqual([]);
    expect(read('services/billing/billing-notify.ts')).toMatch(
      /effect\.kind === 'plan_changed' \|\| effect\.kind === 'downgraded'[\s\S]{0,120}bustStoreCaches\(/
    );
  });

  it('the bust reaches all three layers: KV + generation, per-isolate memory, storefront/edge purge', () => {
    const store = read('services/store.service.ts');
    const fn = store.slice(store.indexOf('export async function bustStoreCaches'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/invalidateStoreDirectory\(/); // (a) directory entries: generation + KV delete
    expect(body).toMatch(/invalidateCached\(`public:store:resolve:/); // (a) the resolved payload: generation + KV delete
    expect(body).toMatch(/bustCorsCache\(/); // (b) per-isolate CORS trust
    expect(body).toMatch(/revalidateStorefront\(/); // (c) storefront data cache + edge HTML, by slug / domain tag
    const cache = read('lib/public-cache.ts');
    const inv = cache.slice(cache.indexOf('export async function invalidateCached'));
    const invBody = inv.slice(0, inv.indexOf('\n}\n'));
    expect(invBody).toMatch(/bumpGeneration\(key\)/); // generation first
    expect(invBody).toMatch(/redis\.delete\(key\)/); // (a) KV
    expect(invBody).toMatch(/memoryCache\.delete\(key\)/); // (b) memory
    expect(invBody).toMatch(/swrRefreshing\.delete\(key\)/); // an in-flight refresh marker
  });

  it('no invalidate helper is orphaned: each has a call site outside its definition', () => {
    const all = files.map(f => read(f));
    for (const name of ['bustStoreCaches', 'invalidateStoreDirectory', 'bustCorsCache']) {
      const calls = all
        .flatMap(src => src.split('\n'))
        .filter(
          l => new RegExp(`\\b${name}\\(`).test(l) && !new RegExp(`function ${name}\\b`).test(l)
        )
        .filter(l => !/^\s*(\*|\/\/)/.test(l));
      expect(calls.length, `${name} has no call site`).toBeGreaterThan(0);
    }
  });
});
