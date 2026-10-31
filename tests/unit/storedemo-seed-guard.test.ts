import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  guard,
  isLocalUrl,
  describePlan,
  assetBase,
  videoUrl,
  variantSku,
  PHASE_S_PLACEHOLDERS,
  PLACEHOLDER_SLUGS,
  TEMPLATE_SPECS,
  templateFromArgv,
  SOUQ_PROD_ASSET_BASE,
  JASMINE_PROD_ASSET_BASE,
  LAMMA_PROD_ASSET_BASE,
  DAHAB_PROD_ASSET_BASE,
  seedStoreClaim,
  SHOWROOM_THEME,
  marketGoldRates,
  pickNewIn,
  // @ts-expect-error plain .mjs script
} from '../../scripts/storedemo/seed.mjs';
// @ts-expect-error plain .mjs data module
import { QAMAR_PRODUCTS } from '../../scripts/qamar-demo/catalogue.mjs';

// Built from parts so secretlint does not read a fixture as a leaked connection string.
const pg = (rest: string) => ['postgresql', '://', rest].join('');

describe('storedemo seed guard', () => {
  it('allows loopback hosts', () => {
    for (const u of [pg('a:b@localhost:5432/x'), pg('a:b@127.0.0.1/x'), pg('a:b@[::1]:5432/x')])
      expect(guard(u, []).ok).toBe(true);
  });
  it('refuses a remote host unless --yes-production', () => {
    const remote = pg('a:b@ep-x.eu-central-1.aws.neon.tech/db');
    expect(isLocalUrl(remote)).toBe(false);
    expect(guard(remote, []).ok).toBe(false);
    expect(guard(remote, ['--allow-remote']).ok).toBe(false);
    expect(guard(remote, ['--yes-production']).ok).toBe(true);
  });
  it('refuses a ?host= / ?hostaddr= override that points the driver at another host', () => {
    for (const u of [
      pg('a:b@localhost:5432/x?host=ep-x.neon.tech'),
      pg('a:b@localhost/x?hostaddr=203.0.113.7'),
      pg('a:b@/x?host=/var/run/postgresql'),
    ]) {
      expect(isLocalUrl(u)).toBe(false);
      expect(guard(u, []).ok).toBe(false);
    }
  });
  it('treats a unix-socket authority as local', () => {
    expect(isLocalUrl(pg('a:b@%2Fvar%2Frun%2Fpostgresql/x'))).toBe(true);
    expect(guard(pg('a:b@%2Fvar%2Frun%2Fpostgresql/x'), []).ok).toBe(true);
  });
  it('refuses a missing or invalid url', () => {
    expect(guard(undefined, ['--yes-production']).ok).toBe(false);
    expect(guard('not a url', ['--yes-production']).ok).toBe(false);
  });
  it('the plan names the host and the counts, and never the credentials', () => {
    const plan = describePlan(pg('user:secretpw@localhost:5432/x'));
    expect(plan).toContain('localhost');
    expect(plan).not.toContain('secretpw');
    expect(plan).toContain(`qamar: ${QAMAR_PRODUCTS.length} products`);
  });
  it('production run refuses any asset base but media.ebda.app/demo/qamar (Ruling B1-16)', () => {
    expect(
      assetBase(['--yes-production'], { QAMAR_DEMO_ASSET_BASE: 'http://localhost:9000' }).ok
    ).toBe(false);
    expect(
      assetBase(['--yes-production'], { QAMAR_DEMO_ASSET_BASE: 'https://pub-x.r2.dev/demo/qamar' })
        .ok
    ).toBe(false);
    expect(assetBase(['--yes-production'], {}).ok).toBe(true); // default
    expect(assetBase(['--yes-production'], {}).base).toBe('https://media.ebda.app/demo/qamar');
    expect(assetBase([], { QAMAR_DEMO_ASSET_BASE: 'http://localhost:9000' }).base).toBe(
      'http://localhost:9000'
    );
  });
  it('the hero clip is only ever an https or relative URL (the hero video schema)', () => {
    expect(videoUrl('https://media.ebda.app/demo/qamar')).toBe(
      'https://media.ebda.app/demo/qamar/hero.mp4'
    );
    expect(videoUrl('/__qamar-demo')).toBe('/__qamar-demo/hero.mp4');
    expect(videoUrl('http://localhost:9000')).toBeNull();
  });
  it('describePlan names the Qamar catalogue and the archived placeholder families (C3)', () => {
    const plan = describePlan(pg('u@localhost/x'));
    expect(plan).toMatch(/qamar: \d+ products/);
    expect(plan).toContain('archived: fashion, electronics, beauty, home-kitchen, jewellery');
  });
  it('the archive list covers all five Phase S families, the fashion products included (C3)', () => {
    expect(PHASE_S_PLACEHOLDERS).toHaveLength(5);
    expect(PLACEHOLDER_SLUGS).toEqual(
      expect.arrayContaining(['linen-shirt', 'wide-trousers', 'wool-scarf', 'leather-belt'])
    );
    const qamar = new Set(QAMAR_PRODUCTS.map((p: { slug: string }) => p.slug));
    for (const s of PLACEHOLDER_SLUGS) expect(qamar.has(s), s).toBe(false);
  });
  it('variant SKUs use full value slugs, so lengths 56 and 58 never collide (C17)', () => {
    expect(variantSku('linen-abaya', ['Rose', 'M', '56'])).toBe('LINEN-ABAYA-ROSE-M-56');
    expect(variantSku('linen-abaya', ['Rose', 'M', '56'])).not.toBe(
      variantSku('linen-abaya', ['Rose', 'M', '58'])
    );
  });
});

describe('storedemo seed: --template souq (Ruling B2-7)', () => {
  const souq = TEMPLATE_SPECS.souq;
  it('--template picks the spec, the default is Qamar, an unknown name is null (the run refuses it)', () => {
    expect(templateFromArgv([])).toBe(TEMPLATE_SPECS.qamar);
    expect(templateFromArgv(['--template', 'souq'])).toBe(souq);
    expect(templateFromArgv(['--template', 'nope'])).toBeNull();
    expect(templateFromArgv(['--template'])).toBeNull();
  });
  it('the second demo store: own slug, own owner without a mailbox, own default look', () => {
    expect(souq.slug).toBe('storedemo-souq');
    expect(souq.ownerEmail).toBe('storedemo-souq-owner@ebda.app');
    expect(souq.defaultLook).toBe('souq.catalogue');
    expect(souq.slug).not.toBe(TEMPLATE_SPECS.qamar.slug);
    expect(souq.ownerEmail).not.toBe(TEMPLATE_SPECS.qamar.ownerEmail);
  });
  it('local look stores: souq-catalogue, souq-night, souq-showroom on their own looks', () => {
    expect(souq.localLookStores).toEqual([
      ['souq-catalogue', 'souq.catalogue'],
      ['souq-night', 'souq.night'],
      ['souq-showroom', 'souq.showroom'],
    ]);
  });
  it('production run accepts only https://media.ebda.app/demo/souq for Souq, and never the Qamar base', () => {
    expect(SOUQ_PROD_ASSET_BASE).toBe('https://media.ebda.app/demo/souq');
    const ok = assetBase(
      ['--yes-production'],
      { SOUQ_DEMO_ASSET_BASE: SOUQ_PROD_ASSET_BASE },
      souq
    );
    expect(ok.ok).toBe(true);
    expect(assetBase(['--yes-production'], {}, souq).base).toBe(SOUQ_PROD_ASSET_BASE);
    for (const bad of [
      'http://localhost:9000',
      'https://media.ebda.app/demo/qamar',
      '/__souq-demo',
    ])
      expect(assetBase(['--yes-production'], { SOUQ_DEMO_ASSET_BASE: bad }, souq).ok, bad).toBe(
        false
      );
    // local runs take a path or a localhost URL
    expect(assetBase([], { SOUQ_DEMO_ASSET_BASE: '/__souq-demo' }, souq).base).toBe('/__souq-demo');
    // the Qamar asset env var does not leak into a Souq run
    expect(assetBase([], { QAMAR_DEMO_ASSET_BASE: '/__qamar-demo' }, souq).base).toBe(
      SOUQ_PROD_ASSET_BASE
    );
  });
  it('describePlan names the Souq catalogue, instalments and NO archived placeholder families', () => {
    const plan = describePlan(pg('user:secretpw@localhost:5432/x'), souq);
    expect(plan).toContain('souq: 19 products, 24 variants, 7 categories');
    expect(plan).toContain('instalments enabled (no provider name)');
    expect(plan).toContain('storedemo-souq');
    expect(plan).not.toContain('archived:');
    expect(plan).not.toContain('secretpw');
  });
  it('the Qamar plan is unchanged by the new parameter', () => {
    expect(describePlan(pg('a:b@localhost/x'))).toContain('archived: fashion');
  });
  it('Qamar never gets the instalments key; Souq gets it with no provider name (B2-9)', () => {
    expect(TEMPLATE_SPECS.qamar.instalments).toBeNull();
    expect(souq.instalments).toEqual({ enabled: true, months: 12, markupPct: 0 });
  });
  it('the guard is the same for both templates: a remote host needs --yes-production', () => {
    const remote = pg('a:b@ep-x.neon.tech/db');
    expect(guard(remote, ['--template', 'souq']).ok).toBe(false);
    expect(guard(remote, ['--template', 'souq', '--yes-production']).ok).toBe(true);
  });
});

describe('storedemo seed: --template jasmine (Ruling B3-8)', () => {
  const jasmine = TEMPLATE_SPECS.jasmine;
  it('--template jasmine picks the third spec', () => {
    expect(templateFromArgv(['--template', 'jasmine'])).toBe(jasmine);
  });
  it('the third demo store: own slug, own owner without a mailbox, own default look, own host label', () => {
    expect(jasmine.slug).toBe('storedemo-jasmine');
    expect(jasmine.ownerEmail).toBe('storedemo-jasmine-owner@ebda.app');
    expect(jasmine.defaultLook).toBe('jasmine.clinic');
    for (const other of [TEMPLATE_SPECS.qamar, TEMPLATE_SPECS.souq]) {
      expect(jasmine.slug).not.toBe(other.slug);
      expect(jasmine.ownerEmail).not.toBe(other.ownerEmail);
    }
    // the slug is in the unclaimable demo family (isDemoShowroomSlug: storedemo-*)
    expect(jasmine.slug.startsWith('storedemo-')).toBe(true);
  });
  it('local look stores: one per Jasmine look, on its own look', () => {
    expect(jasmine.localLookStores).toEqual([
      ['jasmine-apothecary', 'jasmine.apothecary'],
      ['jasmine-bloom', 'jasmine.bloom'],
      ['jasmine-clinic', 'jasmine.clinic'],
    ]);
  });
  it('production run accepts only https://media.ebda.app/demo/jasmine, never another template base', () => {
    expect(JASMINE_PROD_ASSET_BASE).toBe('https://media.ebda.app/demo/jasmine');
    expect(
      assetBase(['--yes-production'], { JASMINE_DEMO_ASSET_BASE: JASMINE_PROD_ASSET_BASE }, jasmine)
        .ok
    ).toBe(true);
    expect(assetBase(['--yes-production'], {}, jasmine).base).toBe(JASMINE_PROD_ASSET_BASE);
    for (const bad of [
      'http://localhost:9000',
      'https://media.ebda.app/demo/qamar',
      SOUQ_PROD_ASSET_BASE,
      '/__jasmine-demo',
    ])
      expect(
        assetBase(['--yes-production'], { JASMINE_DEMO_ASSET_BASE: bad }, jasmine).ok,
        bad
      ).toBe(false);
    expect(assetBase([], { JASMINE_DEMO_ASSET_BASE: '/__jasmine-demo' }, jasmine).base).toBe(
      '/__jasmine-demo'
    );
    // another template's asset env var never leaks into a Jasmine run
    expect(assetBase([], { SOUQ_DEMO_ASSET_BASE: '/__souq-demo' }, jasmine).base).toBe(
      JASMINE_PROD_ASSET_BASE
    );
  });
  it('describePlan names the catalogue, tags, bundle, reviews, the bundles feature and no archive', () => {
    const plan = describePlan(pg('user:secretpw@localhost:5432/x'), jasmine);
    expect(plan).toContain('jasmine: 21 products, 23 variants, 7 categories');
    expect(plan).toContain('6 skin-type / concern tags, 1 routine bundle(s), 13 approved reviews');
    expect(plan).toContain('features bundles');
    expect(plan).toContain('instalments enabled (no provider name)');
    expect(plan).toContain('storedemo-jasmine');
    expect(plan).toContain('the Jasmine superset document');
    expect(plan).not.toContain('archived:');
    expect(plan).not.toContain('secretpw');
  });
  it('only Jasmine writes tags, bundles, reviews and features; Qamar and Souq plans are unchanged', () => {
    for (const other of [TEMPLATE_SPECS.qamar, TEMPLATE_SPECS.souq]) {
      expect(other.tags).toBeUndefined();
      expect(other.bundles).toBeUndefined();
      expect(other.features).toBeUndefined();
      expect(describePlan(pg('a:b@localhost/x'), other)).not.toContain('jasmine-style extras');
    }
    expect(jasmine.features).toEqual(['bundles']);
  });
  it('the guard is the same: a remote host needs --yes-production', () => {
    const remote = pg('a:b@ep-x.neon.tech/db');
    expect(guard(remote, ['--template', 'jasmine']).ok).toBe(false);
    expect(guard(remote, ['--template', 'jasmine', '--yes-production']).ok).toBe(true);
  });
});

describe('storedemo seed: --template lamma (Ruling B4-10)', () => {
  const lamma = TEMPLATE_SPECS.lamma;
  it('--template lamma picks the fourth spec', () => {
    expect(templateFromArgv(['--template', 'lamma'])).toBe(lamma);
  });
  it('the fourth demo store: own slug, own owner without a mailbox, own default look', () => {
    expect(lamma.slug).toBe('storedemo-lamma');
    expect(lamma.ownerEmail).toBe('storedemo-lamma-owner@ebda.app');
    expect(lamma.defaultLook).toBe('lamma.table');
    for (const other of [TEMPLATE_SPECS.qamar, TEMPLATE_SPECS.souq, TEMPLATE_SPECS.jasmine]) {
      expect(lamma.slug).not.toBe(other.slug);
      expect(lamma.ownerEmail).not.toBe(other.ownerEmail);
    }
    expect(lamma.slug.startsWith('storedemo-')).toBe(true);
  });
  it('local look stores: one per Lamma look, on its own look', () => {
    expect(lamma.localLookStores).toEqual([
      ['lamma-table', 'lamma.table'],
      ['lamma-notebook', 'lamma.notebook'],
      ['lamma-market', 'lamma.market'],
    ]);
  });
  it('production run accepts only https://media.ebda.app/demo/lamma, never another template base', () => {
    expect(LAMMA_PROD_ASSET_BASE).toBe('https://media.ebda.app/demo/lamma');
    expect(
      assetBase(['--yes-production'], { LAMMA_DEMO_ASSET_BASE: LAMMA_PROD_ASSET_BASE }, lamma).ok
    ).toBe(true);
    expect(assetBase(['--yes-production'], {}, lamma).base).toBe(LAMMA_PROD_ASSET_BASE);
    for (const bad of [
      'http://localhost:9000',
      'https://media.ebda.app/demo/qamar',
      JASMINE_PROD_ASSET_BASE,
      SOUQ_PROD_ASSET_BASE,
      '/__lamma-demo',
    ])
      expect(assetBase(['--yes-production'], { LAMMA_DEMO_ASSET_BASE: bad }, lamma).ok, bad).toBe(
        false
      );
    expect(assetBase([], { LAMMA_DEMO_ASSET_BASE: '/__lamma-demo' }, lamma).base).toBe(
      '/__lamma-demo'
    );
    // another template's asset env var never leaks into a Lamma run
    expect(assetBase([], { JASMINE_DEMO_ASSET_BASE: '/__jasmine-demo' }, lamma).base).toBe(
      LAMMA_PROD_ASSET_BASE
    );
  });
  it('describePlan names the catalogue, the store settings and no archive, and never prints the password', () => {
    const plan = describePlan(pg('user:secretpw@localhost:5432/x'), lamma);
    expect(plan).toContain('lamma: 28 products,');
    expect(plan).toContain('8 categories');
    expect(plan).toContain('store settings: minimumOrderFils, deliveryOffDays, checkoutDelivery');
    expect(plan).toContain('storedemo-lamma');
    expect(plan).toContain('the Lamma superset document');
    expect(plan).not.toContain('archived:');
    expect(plan).not.toContain('secretpw');
  });
  it('only Lamma writes the food-shop settings; the other plans are unchanged', () => {
    for (const other of [TEMPLATE_SPECS.qamar, TEMPLATE_SPECS.souq, TEMPLATE_SPECS.jasmine]) {
      expect(other.storeSettings).toBeUndefined();
      expect(other.zone).toBeUndefined();
      expect(other.announcement).toBeUndefined();
      expect(describePlan(pg('a:b@localhost/x'), other)).not.toContain('store settings:');
    }
  });
  it('the guard is the same: a remote host needs --yes-production', () => {
    const remote = pg('a:b@ep-x.neon.tech/db');
    expect(guard(remote, ['--template', 'lamma']).ok).toBe(false);
    expect(guard(remote, ['--template', 'lamma', '--yes-production']).ok).toBe(true);
  });
});

// Ruling B2-17 (security review): the seed never takes over a store that is not its own.
describe('storedemo seed: slug ownership (never overwrite a merchant store)', () => {
  const owner = { id: 'owner-seed' };
  it('no store with the slug: the seed may create it', () => {
    expect(seedStoreClaim(null, owner, { demo: true }).ok).toBe(true);
    expect(seedStoreClaim(undefined, owner, { demo: false }).ok).toBe(true);
  });
  it('an existing demo store owned by the seed owner is re-seeded (idempotent)', () => {
    expect(
      seedStoreClaim({ id: 's', isDemo: true, ownerId: 'owner-seed' }, owner, { demo: true }).ok
    ).toBe(true);
  });
  it('a NON-demo store with a demo slug is refused (a merchant registered it first)', () => {
    const r = seedStoreClaim({ id: 's', isDemo: false, ownerId: 'owner-seed' }, owner, {
      demo: true,
    });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/not a demo store/i);
  });
  it('a demo-flagged store owned by someone else is refused (squatted or hand-made)', () => {
    const r = seedStoreClaim({ id: 's', isDemo: true, ownerId: 'a-merchant' }, owner, {
      demo: true,
    });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/owner/i);
  });
  it('a store owned by a merchant is refused whether or not the seed owner exists yet', () => {
    expect(
      seedStoreClaim({ id: 's', isDemo: false, ownerId: 'a-merchant' }, null, { demo: true }).ok
    ).toBe(false);
    expect(
      seedStoreClaim({ id: 's', isDemo: true, ownerId: 'a-merchant' }, null, { demo: true }).ok
    ).toBe(false);
  });
  it('local look stores (non-demo) are only re-seeded when the seed owner owns them', () => {
    expect(
      seedStoreClaim({ id: 's', isDemo: false, ownerId: 'owner-seed' }, owner, { demo: false }).ok
    ).toBe(true);
    expect(
      seedStoreClaim({ id: 's', isDemo: false, ownerId: 'a-merchant' }, owner, { demo: false }).ok
    ).toBe(false);
    // a local look store slug can never silently turn an official demo store into a review store
    expect(
      seedStoreClaim({ id: 's', isDemo: true, ownerId: 'owner-seed' }, owner, { demo: false }).ok
    ).toBe(false);
  });
  it('the run checks every slug BEFORE any write (no partial seed): the claim check precedes the owner create', () => {
    const src = readFileSync(path.resolve(__dirname, '../../scripts/storedemo/seed.mjs'), 'utf8');
    const run = src.slice(src.indexOf('async function run()'));
    const check = run.indexOf('assertSlugsClaimable');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(run.indexOf('tx.user.create'));
    expect(check).toBeLessThan(run.indexOf('prisma.store.upsert'));
    // and the production flag is still required for a non-loopback database
    expect(run.indexOf('guard(url, argv)')).toBeLessThan(check);
  });
});

describe('showroom stores seed the NEW-chip toggle ON (STOP-2 final review, P2-4)', () => {
  it('SHOWROOM_THEME is exactly { showNewBadge: true }', () => {
    expect(SHOWROOM_THEME).toEqual({ showNewBadge: true });
  });
  it('the demo store, the local look stores and the scenario stores all take it (never `theme: {}`)', () => {
    const root = path.resolve(__dirname, '../..');
    for (const f of ['scripts/storedemo/seed.mjs', 'scripts/storedemo/scenario-stores.mjs']) {
      const src = readFileSync(path.join(root, f), 'utf8');
      expect(src, f).not.toMatch(/\btheme:\s*\{\s*\}\s*,/);
      expect(src, f).toContain('SHOWROOM_THEME');
    }
  });
});

describe('storedemo seed: --template dahab (Ruling B5-10)', () => {
  const dahab = TEMPLATE_SPECS.dahab;
  it('--template dahab picks the fifth spec', () => {
    expect(templateFromArgv(['--template', 'dahab'])).toBe(dahab);
  });
  it('the fifth demo store: own slug, own owner without a mailbox, own default look', () => {
    expect(dahab.slug).toBe('storedemo-dahab');
    expect(dahab.ownerEmail).toBe('storedemo-dahab-owner@ebda.app');
    expect(dahab.defaultLook).toBe('dahab.worn');
    for (const other of [
      TEMPLATE_SPECS.qamar,
      TEMPLATE_SPECS.souq,
      TEMPLATE_SPECS.jasmine,
      TEMPLATE_SPECS.lamma,
    ]) {
      expect(dahab.slug).not.toBe(other.slug);
      expect(dahab.ownerEmail).not.toBe(other.ownerEmail);
    }
    expect(dahab.slug.startsWith('storedemo-')).toBe(true);
    expect(dahab.archivePlaceholders).toBe(false);
  });
  it('local look stores: one per Dahab look, on its own look', () => {
    expect(dahab.localLookStores).toEqual([
      ['dahab-worn', 'dahab.worn'],
      ['dahab-workshop', 'dahab.workshop'],
      ['dahab-giftbox', 'dahab.giftbox'],
    ]);
  });
  it('production run accepts only https://media.ebda.app/demo/dahab, never another template base', () => {
    expect(DAHAB_PROD_ASSET_BASE).toBe('https://media.ebda.app/demo/dahab');
    expect(
      assetBase(['--yes-production'], { DAHAB_DEMO_ASSET_BASE: DAHAB_PROD_ASSET_BASE }, dahab).ok
    ).toBe(true);
    expect(assetBase(['--yes-production'], {}, dahab).base).toBe(DAHAB_PROD_ASSET_BASE);
    for (const bad of [
      'http://localhost:9000',
      'https://media.ebda.app/demo/qamar',
      LAMMA_PROD_ASSET_BASE,
      JASMINE_PROD_ASSET_BASE,
      '/__dahab-demo',
    ])
      expect(assetBase(['--yes-production'], { DAHAB_DEMO_ASSET_BASE: bad }, dahab).ok, bad).toBe(
        false
      );
    expect(assetBase([], { LAMMA_DEMO_ASSET_BASE: '/__lamma-demo' }, dahab).base).toBe(
      DAHAB_PROD_ASSET_BASE
    );
  });
  it('describePlan names the catalogue and the gold pricing, and never prints the password', () => {
    const plan = describePlan(pg('user:secretpw@localhost:5432/x'), dahab);
    expect(plan).toContain('dahab: 21 products,');
    expect(plan).toContain('storedemo-dahab');
    expect(plan).toContain('gold pricing: 6 gold-rate products');
    expect(plan).toContain('automatic rate ON');
    expect(plan).toContain('the Dahab superset document');
    expect(plan).not.toContain('archived:');
    expect(plan).not.toContain('secretpw');
  });
  it('only Dahab prices gold: the other plans never mention it', () => {
    for (const other of [
      TEMPLATE_SPECS.qamar,
      TEMPLATE_SPECS.souq,
      TEMPLATE_SPECS.jasmine,
      TEMPLATE_SPECS.lamma,
    ]) {
      expect(other.gold).toBeUndefined();
      expect(describePlan(pg('a:b@localhost/x'), other)).not.toContain('gold pricing');
    }
  });
  it('the demo turns the automatic rate on (Ruling DEMO-GOLD-1, Ahmad 2026-10-23)', () => {
    expect(dahab.gold.feed).toBe(true);
  });
  it("a re-seed never writes a gold row's price (the DB trigger would refuse it)", () => {
    const src = readFileSync(path.resolve(__dirname, '../../scripts/storedemo/seed.mjs'), 'utf8');
    expect(src).toMatch(/update: p\.gold \? dataNoPrice : data/);
    expect(src).toMatch(/if \(p\.gold\) \{\s+delete vData\.price;\s+delete vData\.compareAtPrice;/);
  });
});

describe('dahab seed gold rates track the market', () => {
  const fallback = [
    { karat: 24, ratePerGram: 710_100 },
    { karat: 21, ratePerGram: 621_400 },
    { karat: 18, ratePerGram: 532_600 },
  ];
  const cand = new Map([
    [24, 720_000],
    [21, 630_000],
    [18, 540_000],
  ]);
  const feedOf = (res: unknown, throws = false) => ({
    goldFeed: () => ({
      fetch: async () => {
        if (throws) throw new Error('network');
        return res;
      },
    }),
    storeCandidateRates: () => cand,
  });
  it('stamps the live feed rates when the feed is ok', async () => {
    const r = await marketGoldRates(fallback, feedOf({ kind: 'ok', quote: {} }));
    expect(r.source).toBe('feed');
    expect(r.rates).toEqual([
      { karat: 24, ratePerGram: 720_000 },
      { karat: 21, ratePerGram: 630_000 },
      { karat: 18, ratePerGram: 540_000 },
    ]);
  });
  it('falls back to the constants when the feed is down, disagrees or throws', async () => {
    for (const f of [feedOf({ kind: 'down' }), feedOf({ kind: 'disagree' }), feedOf(null, true)]) {
      const r = await marketGoldRates(fallback, f);
      expect(r).toEqual({ rates: fallback, source: 'fallback' });
    }
  });
  it('the fallback constants stay within the 500 bps jump gate of market (24k 7,101 EGP/g on 2026-10-23)', () => {
    const k24 = TEMPLATE_SPECS.dahab.gold.rates.find((x: { karat: number }) => x.karat === 24)!;
    expect(Math.abs(k24.ratePerGram - 710_142) / 710_142).toBeLessThan(0.05);
  });
});

describe('pickNewIn ("New in" flags)', () => {
  it('flags 12 photo products for every template', () => {
    for (const spec of Object.values(TEMPLATE_SPECS) as { products: { images: string[] }[] }[])
      expect(pickNewIn(spec, 12).size).toBe(12);
  });

  it('Lamma flags at least one dish in every category, so the Table menu shows every tab', () => {
    const spec = TEMPLATE_SPECS.lamma;
    const slugs = pickNewIn(spec, 12) as Set<string>;
    const cats = new Set(
      spec.products
        .filter((p: { slug: string }) => slugs.has(p.slug))
        .map((p: { category: string }) => p.category)
    );
    expect(cats.size).toBe(spec.categories.length);
  });
});
