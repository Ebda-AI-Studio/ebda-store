#!/usr/bin/env node
/**
 * rls-payload-parity.mjs — the gate that would have caught the 2026-09-25
 * RLS cutover rollback.
 *
 * WHAT HAPPENED: production's API was switched to the non-bypass `ebda_app`
 * role after the full integration suite passed with the API running as
 * ebda_app. Within minutes the public store payloads came back with
 * `faqs: []` / `howtos: []` for stores that have 24/9 active rows. The
 * `store_faqs` / `store_howtos` policies are STRICT (no contextless
 * allowance) and the public routes read them with no tenant context, so RLS
 * filtered every row out. Nothing errored. Every test that ran was green,
 * because no test compared WHAT CAME BACK as owner against what came back as
 * ebda_app.
 *
 * WHAT THIS DOES: boots the built API twice against the SAME database —
 * once with DATABASE_URL as the owner/superuser (RLS bypassed, i.e. today's
 * production) and once as `ebda_app` (RLS enforced, i.e. the cutover) —
 * calls a fixed list of public/storefront endpoints for every store in the
 * DB, and deep-diffs the JSON. A silent RLS filter shows up here as an array
 * that shrank or a field that disappeared, and fails the run.
 *
 * Usage:
 *   PARITY_OWNER_DATABASE_URL=<owner or superuser URL> \
 *   PARITY_APP_DATABASE_URL=<ebda_app login URL, same database> \
 *   node scripts/rls-payload-parity.mjs [--seed] [--report out.json]
 *
 *   --seed     insert two realistic fixture stores first (FAQs, howtos,
 *              locations, bundles, blog posts, pages, product FAQs, AI
 *              recommendations, product search vectors, shipping zones, loyalty). Idempotent: an
 *              existing fixture store is reused, never duplicated.
 *   --report   write the full per-endpoint result as JSON.
 *
 * Requires a built API (`npm run build -w apps/api`). Env knobs:
 *   PARITY_API_ENTRY    default apps/api/dist/index.js
 *   PARITY_MAX_STORES   default 50
 *   PARITY_ALLOW_REMOTE set to 1 to run against a non-local host. The run
 *                       WRITES guest carts, so it refuses by default.
 *
 * Exit codes: 0 parity holds · 1 parity broken · 2 the harness itself could
 * not prove anything (bad setup, a server that would not boot, the app URL
 * turned out to bypass RLS, nothing to compare). A 2 is never a pass.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@ebda/database';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SEED = args.includes('--seed');
const reportIdx = args.indexOf('--report');
const REPORT_PATH = reportIdx >= 0 ? args[reportIdx + 1] : null;

const OWNER_URL = process.env.PARITY_OWNER_DATABASE_URL;
const APP_URL = process.env.PARITY_APP_DATABASE_URL;
const API_ENTRY = path.resolve(ROOT, process.env.PARITY_API_ENTRY || 'apps/api/dist/index.js');
const MAX_STORES = Number(process.env.PARITY_MAX_STORES) || 50;
const OWNER_PORT = Number(process.env.PARITY_OWNER_PORT) || 4811;
const APP_PORT = Number(process.env.PARITY_APP_PORT) || 4812;
const LOAD_TEST_TOKEN = randomBytes(16).toString('hex');
const RUN_NONCE = randomBytes(4).toString('hex');

// Keys whose value legitimately differs between two servers / two runs.
// Everything else must match exactly. Deliberately short: every name here is
// a place a regression can hide.
const ALWAYS_IGNORED = new Set(['timestamp', 'requestId', 'generated_at']);
// Cart flows create a fresh cart per server, so their ids and clocks differ.
const CART_IGNORED = new Set([
  'id',
  'cartId',
  'cartBundleId',
  'sessionId',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'lastActivityAt',
]);

function die(code, msg) {
  console.error(`\n[parity] ${msg}`);
  process.exit(code);
}

function assertLocal(url, name) {
  if (process.env.PARITY_ALLOW_REMOTE === '1') return;
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    die(
      2,
      `${name} points at ${host}. This harness writes guest carts; set PARITY_ALLOW_REMOTE=1 if that is really intended.`
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture seeding (--seed)
// ---------------------------------------------------------------------------

const FIXTURES = [
  { slug: 'parity-pecan', domain: 'parity-pecan.test', name: 'Parity Pecan', faqs: 6, howtos: 3 },
  { slug: 'parity-shop', domain: 'parity-shop.test', name: 'Parity Shop', faqs: 4, howtos: 2 },
];

async function seedFixtures(db) {
  for (const f of FIXTURES) {
    const existing = await db.store.findUnique({ where: { slug: f.slug }, select: { id: true } });
    if (existing) {
      console.log(`[parity] fixture ${f.slug} exists, reusing`);
      continue;
    }
    const owner = await db.user.create({
      data: {
        email: `${f.slug}-owner@parity.test`,
        passwordHash: 'x',
        firstName: 'Parity',
        lastName: 'Owner',
        role: 'store_admin',
        emailVerified: true,
      },
      select: { id: true },
    });
    const store = await db.store.create({
      data: {
        name: f.name,
        nameAr: `${f.name} AR`,
        slug: f.slug,
        domain: f.domain,
        // Only a VERIFIED domain resolves (SP5 task 4); the parity fixtures are.
        domainStatus: 'active',
        ownerId: owner.id,
        status: 'active',
        plan: 'enterprise',
        currency: 'EGP',
        template: 'modern',
        theme: { primaryColor: '36 36% 52%', showBranchesInFooter: true },
        marketingPixels: {},
        blogEnabled: true,
        locationsEnabled: true,
        loyaltyEnabled: true,
        llmsTxt: `# ${f.name}`,
        aboutJson: { story: 'parity fixture' },
      },
      select: { id: true },
    });
    const storeId = store.id;
    await db.storeFeature.createMany({
      data: ['bundles', 'loyalty', 'upsell_crosssell', 'search_autocomplete', 'pwa'].map(k => ({
        storeId,
        featureKey: k,
        enabled: true,
      })),
    });
    for (let i = 0; i < f.faqs; i++) {
      await db.storeFaq.create({
        data: {
          storeId,
          question: `Q${i}?`,
          questionAr: `س${i}؟`,
          answer: `A${i}`,
          answerAr: `ج${i}`,
          orderIndex: i,
          isActive: true,
        },
      });
    }
    // One inactive row proves the `isActive` filter still applies.
    await db.storeFaq.create({
      data: { storeId, question: 'hidden?', answer: 'hidden', orderIndex: 99, isActive: false },
    });
    for (let i = 0; i < f.howtos; i++) {
      await db.storeHowto.create({
        data: {
          storeId,
          title: `How to ${i}`,
          description: `desc ${i}`,
          steps: [{ name: 'step 1', text: 'do it' }],
          orderIndex: i,
        },
      });
    }
    for (let i = 0; i < 3; i++) {
      await db.storeLocation.create({
        data: {
          storeId,
          name: `Branch ${i}`,
          country: 'Egypt',
          address: `Block ${i}`,
          phone: '+96500000000',
          position: i,
        },
      });
    }
    const cat = await db.category.create({
      data: { storeId, name: 'Nuts', slug: 'nuts', isActive: true },
      select: { id: true },
    });
    // B0 commerce data rides ONE product (index 3: the cart flow below uses the first product
    // and must not hit a required-personalisation 400) so the owner/ebda_app diff covers the new
    // public fields: facts, personalisation, lead time, the size chart (a new strict-RLS table
    // read through a product -> chart include) and option-value swatches.
    const sizeChart = await db.sizeChart.create({
      data: {
        storeId,
        name: 'Parity chart',
        nameAr: 'مقاسات',
        unit: 'cm',
        columns: [
          { label: 'Size', labelAr: 'المقاس' },
          { label: 'Length', labelAr: 'الطول' },
        ],
        rows: [
          ['S', '52'],
          ['M', '54'],
        ],
      },
      select: { id: true },
    });
    const products = [];
    for (let i = 0; i < 4; i++) {
      const p = await db.product.create({
        data: {
          storeId,
          ...(i === 3
            ? {
                facts: [
                  { key: 'Fabric', keyAr: 'الخامة', value: 'Linen', valueAr: 'كتان', onCard: true },
                ],
                personalisation: {
                  enabled: true,
                  required: false,
                  label: 'Name',
                  labelAr: 'الاسم',
                  maxLength: 12,
                },
                leadTimeDays: 5,
                sizeChartId: sizeChart.id,
              }
            : {}),
          name: `Product ${i}`,
          slug: `product-${i}`,
          description: `Product ${i} description`,
          price: 1000 + i * 250,
          inventory: 50,
          status: 'active',
          featured: i === 0,
          sku: `PARITY-${f.slug}-${i}`,
        },
        select: { id: true },
      });
      products.push(p.id);
      if (i === 3) {
        await db.productOption.create({
          data: {
            productId: p.id,
            name: 'Colour',
            nameAr: 'اللون',
            position: 0,
            values: {
              create: [
                { value: 'Red', valueAr: 'أحمر', swatchHex: '#C0392B', position: 0 },
                {
                  value: 'Blue',
                  swatchImageUrl: `https://example.test/${f.slug}/blue.jpg`,
                  position: 1,
                },
              ],
            },
          },
        });
      }
      await db.productImage.create({
        data: { productId: p.id, url: `https://example.test/${f.slug}/${i}.jpg`, position: 0 },
      });
      await db.productCategory.create({ data: { productId: p.id, categoryId: cat.id } });
      await db.productFaq.create({
        data: { productId: p.id, question: `Is ${i} fresh?`, answer: 'Yes' },
      });
      // Search P1: one vector per product (`product_embeddings`, strict RLS; Prisma cannot write
      // halfvec, so raw SQL) so the storefront search's vector leg is in the owner-vs-ebda_app diff.
      const vec = `[${Array.from({ length: 1024 }, (_, d) => (d === i ? 1 : 0)).join(',')}]`;
      await db.$executeRaw`INSERT INTO product_embeddings (product_id, store_id, model, content_hash, embedding)
        VALUES (${p.id}, ${storeId}, 'parity-fixture', md5(${p.id}), ${vec}::halfvec(1024))`;
    }
    await db.aiRecommendation.createMany({
      data: [
        // Sourced from product 1, NOT product 0: product 0 has a manual
        // cross-sell relation below, and manual relations win, so AI rows on
        // product 0 would never be read and never compared.
        { storeId, sourceProductId: products[1], targetProductId: products[2], score: 0.9 },
        { storeId, sourceProductId: products[1], targetProductId: products[3], score: 0.8 },
      ],
    });
    await db.productRelation.create({
      data: {
        storeId,
        sourceProductId: products[0],
        targetProductId: products[3],
        type: 'cross_sell',
      },
    });
    for (let i = 0; i < 2; i++) {
      await db.bundle.create({
        data: {
          storeId,
          name: `Bundle ${i}`,
          slug: `bundle-${i}`,
          pricingType: 'percentage',
          pricingValue: 1000,
          items: {
            create: [
              { productId: products[0], quantity: 1 },
              { productId: products[1 + i], quantity: 2 },
            ],
          },
        },
      });
    }
    for (let i = 0; i < 4; i++) {
      await db.blogPost.create({
        data: {
          storeId,
          slug: `post-${i}`,
          title: `Post ${i}`,
          content: `Body ${i}`,
          isPublished: i < 3,
          publishedAt: i < 3 ? new Date(Date.UTC(2026, 0, 1 + i)) : null,
        },
      });
    }
    await db.storePage.create({
      data: {
        storeId,
        slug: 'about',
        title: 'About',
        contentBlocks: [{ type: 'text', text: 'hi' }],
      },
    });
    await db.storePage.create({ data: { storeId, slug: 'privacy', isPublished: false } });
    await db.shippingZone.create({
      data: { storeId, name: 'Capital', areas: ['Salmiya'], deliveryFee: 1000 },
    });
    console.log(`[parity] seeded fixture ${f.slug} (${storeId})`);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function startApi(label, port, databaseUrl) {
  const env = { ...process.env };
  // Never let a DATABASE_URL from the caller's shell leak into either server.
  delete env.DATABASE_URL;
  Object.assign(env, {
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    // Migrations are never run by this harness; DIRECT_URL only needs to parse.
    DIRECT_URL: OWNER_URL,
    NODE_ENV: 'test',
    INNGEST_DRY_RUN: 'true',
    ALLOW_BYPASSRLS_ROLE: 'true',
    LOAD_TEST_BYPASS_TOKEN: LOAD_TEST_TOKEN,
    // Each server gets its own Redis namespace. Sharing one would let the
    // second server answer from the FIRST server's cache and pass for free.
    REDIS_KEY_PREFIX: `rls-parity-${RUN_NONCE}-${label}:`,
    JWT_SECRET: env.JWT_SECRET || 'rls-parity-jwt-secret-not-for-prod-32ch',
    ENCRYPTION_KEY: env.ENCRYPTION_KEY || 'rls-parity-encryption-key-32chars!',
    LOG_LEVEL: env.LOG_LEVEL || 'warn',
  });
  const child = spawn(process.execPath, [API_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logTail = [];
  const keep = chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue;
      logTail.push(line);
      if (logTail.length > 60) logTail.shift();
    }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return { label, port, child, logTail, base: `http://127.0.0.1:${port}` };
}

async function waitHealthy(server) {
  for (let i = 0; i < 90; i++) {
    if (server.child.exitCode !== null) break;
    try {
      const r = await fetch(`${server.base}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error(server.logTail.join('\n'));
  die(2, `${server.label} API did not become healthy on :${server.port}`);
}

function stopAll(servers) {
  for (const s of servers) {
    if (s && s.child.exitCode === null) s.child.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function diff(a, b, at, ignored, out) {
  if (a === b) return;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) {
    out.push({ kind: 'type-changed', path: at, owner: summarize(a), app: summarize(b) });
    return;
  }
  if (ta === 'array') {
    if (b.length < a.length) {
      out.push({ kind: 'array-shrunk', path: at, owner: a.length, app: b.length });
    } else if (b.length > a.length) {
      out.push({ kind: 'array-grew', path: at, owner: a.length, app: b.length });
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${at}[${i}]`, ignored, out);
    return;
  }
  if (ta === 'object') {
    for (const k of Object.keys(a)) {
      if (ignored.has(k)) continue;
      if (!(k in b))
        out.push({ kind: 'field-missing', path: `${at}.${k}`, owner: summarize(a[k]) });
      else diff(a[k], b[k], `${at}.${k}`, ignored, out);
    }
    for (const k of Object.keys(b)) {
      if (ignored.has(k)) continue;
      if (!(k in a)) out.push({ kind: 'field-added', path: `${at}.${k}`, app: summarize(b[k]) });
    }
    return;
  }
  out.push({ kind: 'value-changed', path: at, owner: summarize(a), app: summarize(b) });
}

function summarize(v) {
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v && typeof v === 'object') return `object(${Object.keys(v).length} keys)`;
  const s = JSON.stringify(v);
  return s && s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** Count array elements the owner returned — proves the run compared real data. */
function countElements(v) {
  if (Array.isArray(v)) return v.length + v.reduce((n, x) => n + countElements(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((n, x) => n + countElements(x), 0);
  return 0;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

async function call(server, req) {
  const headers = {
    accept: 'application/json',
    'x-load-test-token': LOAD_TEST_TOKEN,
    ...(req.body ? { 'content-type': 'application/json' } : {}),
    ...req.headers,
  };
  const res = await fetch(`${server.base}/api/v1${req.path}`, {
    method: req.method || 'GET',
    headers,
    body: req.body ? JSON.stringify(req.body) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** The fixed read list for one store. Every entry is a storefront-facing call. */
function readEndpoints(s) {
  const id = s.id;
  const byId = { 'x-store-id': id };
  const list = [
    { name: 'store by slug', path: `/public/stores/${encodeURIComponent(s.slug)}` },
    { name: 'store by id', path: `/public/stores/${id}` },
    { name: 'products', path: '/public/products?limit=50', headers: byId },
    { name: 'products featured', path: '/public/products?featured=true&limit=8', headers: byId },
    { name: 'products newest', path: '/public/products?sort=newest&limit=8', headers: byId },
    { name: 'categories', path: '/public/categories', headers: byId },
    { name: 'size charts', path: '/public/size-charts', headers: byId },
    { name: 'product feed', path: '/public/feed/products.json', headers: byId },
    { name: 'layout', path: `/public/stores/${id}/layout` },
    { name: 'testimonials', path: `/public/stores/${id}/testimonials` },
    { name: 'blog list', path: `/public/${id}/blog` },
    { name: 'locations', path: `/public/${id}/locations` },
    { name: 'shipping options', path: `/stores/public/${id}/shipping` },
    { name: 'shipping area rates', path: `/stores/public/${id}/shipping/area-rates` },
    { name: 'bundles', path: `/stores/public/${id}/bundles` },
    { name: 'loyalty info', path: `/stores/public/${id}/loyalty/info` },
    { name: 'pwa manifest', path: `/stores/public/${id}/manifest.json` },
    { name: 'pwa config', path: `/stores/public/${id}/pwa/config` },
    { name: 'search suggest', path: `/public/${id}/search/suggest?q=pr`, headers: byId },
    { name: 'cart recommendations', path: `/public/${id}/cart/recommendations` },
  ];
  if (s.domain) {
    list.push({
      name: 'store resolve by domain',
      path: '/public/store/resolve',
      headers: { 'x-store-domain': s.domain },
    });
    list.push({
      name: 'products by domain',
      path: '/public/products?limit=50',
      headers: { 'x-store-domain': s.domain },
    });
  }
  for (const p of s.products) {
    list.push({
      name: `product ${p.slug}`,
      path: `/public/products/${encodeURIComponent(p.slug)}`,
      headers: byId,
    });
    list.push({
      name: `recommendations ${p.slug}`,
      path: `/public/${id}/products/${p.id}/recommendations`,
    });
    list.push({ name: `reviews ${p.slug}`, path: `/stores/${id}/reviews/product/${p.id}` });
  }
  for (const b of s.blogSlugs) {
    list.push({ name: `blog ${b}`, path: `/public/${id}/blog/${encodeURIComponent(b)}` });
  }
  for (const pg of s.pageSlugs) {
    list.push({ name: `page ${pg}`, path: `/public/${id}/pages/${encodeURIComponent(pg)}` });
  }
  for (const b of s.bundleSlugs) {
    list.push({
      name: `bundle ${b}`,
      path: `/stores/public/${id}/bundles/${encodeURIComponent(b)}`,
    });
  }
  return list;
}

/** A cart flow: create + add + read, run independently on each server. */
async function cartFlow(server, s) {
  const session = `parity-${RUN_NONCE}-${server.label}-${s.id.slice(0, 8)}`;
  const headers = { 'x-store-id': s.id, 'x-session-id': session };
  const steps = [];
  steps.push(await call(server, { path: '/public/cart', headers }));
  const product = s.products.find(p => p.inventory > 0);
  if (product) {
    steps.push(
      await call(server, {
        method: 'POST',
        path: '/public/cart/items',
        headers,
        body: { productId: product.id, quantity: 1 },
      })
    );
  }
  if (s.bundleIds[0]) {
    steps.push(
      await call(server, {
        method: 'POST',
        path: '/public/cart/bundles',
        headers,
        body: { bundleId: s.bundleIds[0], quantity: 1 },
      })
    );
  }
  steps.push(await call(server, { path: '/public/cart', headers }));
  return steps;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadStores(db) {
  const stores = await db.store.findMany({
    where: { deletedAt: null, status: { in: ['active', 'suspended'] } },
    select: { id: true, slug: true, domain: true, status: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_STORES,
  });
  for (const s of stores) {
    s.products = await db.product.findMany({
      where: { storeId: s.id, status: 'active', deletedAt: null },
      select: { id: true, slug: true, inventory: true },
      orderBy: { createdAt: 'asc' },
      // 4 = every seeded product, so the PDP of the B0 commerce product (index 3) is compared.
      take: 4,
    });
    s.blogSlugs = (
      await db.blogPost.findMany({
        where: { storeId: s.id, isPublished: true },
        select: { slug: true },
        orderBy: { createdAt: 'asc' },
        take: 2,
      })
    ).map(r => r.slug);
    s.pageSlugs = (
      await db.storePage.findMany({
        where: { storeId: s.id },
        select: { slug: true },
        orderBy: { slug: 'asc' },
        take: 4,
      })
    ).map(r => r.slug);
    const bundles = await db.bundle.findMany({
      where: { storeId: s.id, isActive: true },
      select: { id: true, slug: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    s.bundleSlugs = bundles.map(b => b.slug);
    s.bundleIds = bundles.map(b => b.id);
  }
  return stores;
}

async function roleBypasses(url) {
  const db = createPrismaClient({ connectionString: url, max: 2 });
  try {
    const rows = await db.$queryRaw`
      SELECT r.rolname::text AS role, (r.rolbypassrls OR r.rolsuper) AS bypass
      FROM pg_roles r WHERE r.rolname = current_user`;
    return rows[0];
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  if (!OWNER_URL || !APP_URL) {
    die(
      2,
      'set PARITY_OWNER_DATABASE_URL (owner/superuser) and PARITY_APP_DATABASE_URL (ebda_app)'
    );
  }
  assertLocal(OWNER_URL, 'PARITY_OWNER_DATABASE_URL');
  assertLocal(APP_URL, 'PARITY_APP_DATABASE_URL');

  // Positive control on the two roles. If the "app" URL can bypass RLS, the
  // two servers are the same server and every comparison passes vacuously.
  const ownerRole = await roleBypasses(OWNER_URL);
  const appRole = await roleBypasses(APP_URL);
  console.log(`[parity] owner role: ${ownerRole.role} (bypass=${ownerRole.bypass})`);
  console.log(`[parity] app role:   ${appRole.role} (bypass=${appRole.bypass})`);
  if (appRole.bypass) die(2, 'the app URL bypasses RLS — this run could not detect anything');
  if (!ownerRole.bypass) die(2, 'the owner URL does not bypass RLS — there is no baseline');

  const db = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
  let stores;
  try {
    if (SEED) await seedFixtures(db);
    stores = await loadStores(db);
  } finally {
    await db.$disconnect();
  }
  if (stores.length === 0) die(2, 'no active stores in the database — nothing to compare');
  console.log(`[parity] ${stores.length} store(s) to compare`);

  const servers = [];
  const cleanup = () => stopAll(servers);
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  servers.push(startApi('owner', OWNER_PORT, OWNER_URL));
  servers.push(startApi('app', APP_PORT, APP_URL));
  const [owner, app] = servers;
  await Promise.all([waitHealthy(owner), waitHealthy(app)]);
  console.log('[parity] both API servers healthy');

  const results = [];
  let ownerElements = 0;

  for (const s of stores) {
    for (const ep of readEndpoints(s)) {
      const [o, a] = await Promise.all([call(owner, ep), call(app, ep)]);
      const issues = [];
      if (o.status !== a.status) {
        issues.push({ kind: 'status-changed', path: '$', owner: o.status, app: a.status });
      } else {
        diff(o.body, a.body, '$', ALWAYS_IGNORED, issues);
      }
      ownerElements += countElements(o.body);
      results.push({ store: s.slug, endpoint: ep.name, path: ep.path, status: o.status, issues });
    }
    const [oc, ac] = await Promise.all([cartFlow(owner, s), cartFlow(app, s)]);
    oc.forEach((o, i) => {
      const a = ac[i];
      const issues = [];
      if (o.status !== a.status) {
        issues.push({ kind: 'status-changed', path: '$', owner: o.status, app: a.status });
      } else {
        diff(o.body, a.body, '$', new Set([...ALWAYS_IGNORED, ...CART_IGNORED]), issues);
      }
      ownerElements += countElements(o.body);
      results.push({ store: s.slug, endpoint: `cart step ${i + 1}`, status: o.status, issues });
    });
  }

  stopAll(servers);

  const failed = results.filter(r => r.issues.length > 0);
  const ownerErrors = results.filter(r => r.status >= 500);
  console.log('');
  for (const r of results) {
    const mark = r.issues.length ? 'FAIL' : 'ok  ';
    console.log(`${mark} ${String(r.status).padEnd(3)} ${r.store.padEnd(24)} ${r.endpoint}`);
    for (const i of r.issues) {
      console.log(
        `       ${i.kind} ${i.path}` +
          (i.owner !== undefined ? ` owner=${i.owner}` : '') +
          (i.app !== undefined ? ` app=${i.app}` : '')
      );
    }
  }
  console.log(
    `\n[parity] ${results.length} comparisons, ${stores.length} stores, ` +
      `${ownerElements} array elements returned by the owner server`
  );
  if (ownerErrors.length) {
    console.log(
      `[parity] note: ${ownerErrors.length} call(s) are 5xx on the OWNER server too — ` +
        'broken regardless of RLS, not a parity finding:'
    );
    for (const r of ownerErrors) console.log(`       ${r.store} ${r.endpoint}`);
  }
  if (REPORT_PATH) {
    writeFileSync(REPORT_PATH, JSON.stringify({ stores: stores.length, results }, null, 2));
  }
  if (ownerElements === 0)
    die(2, 'the owner server returned no array data at all — nothing was compared');
  if (failed.length) {
    die(1, `PARITY BROKEN: ${failed.length} of ${results.length} comparisons differ as ebda_app`);
  }
  console.log('[parity] PASS — ebda_app payloads match the owner payloads');
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
