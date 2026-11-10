#!/usr/bin/env node
// Pre-launch QA store provisioner (docs/testing/prelaunch-program.md). Idempotent: safe to re-run.
// Touches ONE store only: the one whose slug is PRELAUNCH_STORE_SLUG, owned by the signed-in QA merchant.
// It applies a look, adds a bilingual catalogue (creates only the slugs that are missing), a Cairo/Giza
// shipping zone, COD + InstaPay (manual) and takes the store live. It never touches another store.
//
// Env: PRELAUNCH_EMAIL, PRELAUNCH_PASSWORD (QA merchant), PRELAUNCH_STORE_SLUG (default ameliaaurum),
//      EBDA_API (default https://api.ebda.app/api/v1), EBDA_ACCOUNTS (default https://accounts.ebda.app).
// Output: one JSON line per step on stdout; exit 1 on the first failed step.
const API = process.env.EBDA_API ?? 'https://api.ebda.app/api/v1';
const ACCOUNTS = process.env.EBDA_ACCOUNTS ?? 'https://accounts.ebda.app';
const SLUG = process.env.PRELAUNCH_STORE_SLUG ?? 'ameliaaurum';
const { PRELAUNCH_EMAIL: email, PRELAUNCH_PASSWORD: password } = process.env;
if (!email || !password) {
  console.error('PRELAUNCH_EMAIL and PRELAUNCH_PASSWORD are required');
  process.exit(2);
}

const MEDIA = 'https://media.ebda.app/demo/qamar';
export const CATALOGUE = [
  ['qa-linen-kaftan', 'Linen Kaftan', 'قفطان كتان', 175000, 'linen-kaftan'],
  [
    'qa-classic-black-abaya',
    'Classic Black Abaya',
    'عباية سوداء كلاسيك',
    129000,
    'classic-black-abaya',
  ],
  ['qa-cotton-scarf-set', 'Cotton Scarf Set', 'طقم طرح قطن', 45000, 'cotton-scarf-set'],
  ['qa-silk-shawl', 'Silk Shawl', 'شال حرير', 54000, 'silk-shawl'],
  ['qa-pleated-dress', 'Pleated Dress', 'فستان بليسيه', 240000, 'pleated-dress'],
  ['qa-satin-midi-dress', 'Satin Midi Dress', 'فستان ساتان ميدي', 285000, 'satin-midi-dress'],
  ['qa-open-front-abaya', 'Open Front Abaya', 'عباية مفتوحة', 165000, 'open-front-abaya'],
  ['qa-velvet-kaftan', 'Velvet Kaftan', 'قفطان قطيفة', 260000, 'velvet-kaftan'],
];

const log = o => console.log(JSON.stringify(o));
let token;

async function call(method, path, body, { allow = [] } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !allow.includes(res.status)) {
    log({ step: `${method} ${path}`, ok: false, status: res.status, error: json.error ?? null });
    process.exit(1);
  }
  return { status: res.status, json };
}

async function login() {
  const res = await fetch(`${ACCOUNTS}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, aud: 'store' }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.data?.access_token) {
    log({ step: 'login', ok: false, status: res.status, error: json.error ?? json.data ?? null });
    process.exit(1);
  }
  token = json.data.access_token;
  log({ step: 'login', ok: true });
}

await login();
const stores = (await call('GET', '/stores')).json.data.stores;
const store = stores.find(s => s.slug === SLUG);
if (!store) {
  log({ step: 'find-store', ok: false, slug: SLUG, owned: stores.map(s => s.slug) });
  process.exit(1);
}
log({ step: 'find-store', ok: true, id: store.id, status: store.status });
const S = `/stores/${store.id}`;

// Non-fatal: PUT /stores/:id answered 501 STORE_READ_UNSUPPORTED on DO stores (2026-11-10, bug PRE-2).
const rename = await call(
  'PUT',
  S,
  { name: 'QA Launch (test store, not a real shop)' },
  { allow: [501] }
);
log({
  step: 'rename',
  ok: rename.status < 400,
  status: rename.status,
  error: rename.json.error?.code,
});

const look = await call('PUT', `${S}/look`, { lookId: 'qamar.atelier' }, { allow: [403, 501] });
log({ step: 'look', ok: look.status < 400, status: look.status, error: look.json.error?.code });

const existing = await call('GET', `${S}/products?limit=100`);
const have = new Set((existing.json.data?.products ?? existing.json.data ?? []).map(p => p.slug));
const SEED = process.env.PRELAUNCH_SEED_CATALOGUE === '1'; // the Amelia store's catalogue is entered through the admin UI
for (const [slug, name, nameAr, price, img] of SEED ? CATALOGUE : []) {
  if (have.has(slug)) continue;
  await call('POST', `${S}/products`, {
    slug,
    name,
    nameAr,
    price,
    inventory: 500,
    status: 'active',
    description: `${name}. A test product on the Ebda pre-launch QA store. Not for sale.`,
    descriptionAr: `${nameAr}. منتج تجريبي على متجر اختبار ابدأ. مش للبيع.`,
    images: [{ url: `${MEDIA}/${img}-1.webp`, alt: name }],
  });
}
log({
  step: 'catalogue',
  ok: true,
  created: SEED ? CATALOGUE.filter(c => !have.has(c[0])).length : 0,
  seeded: SEED,
});

const zones = (await call('GET', `${S}/shipping`)).json.data;
const zoneList = Array.isArray(zones) ? zones : (zones?.zones ?? []);
if (!zoneList.some(z => z.name === 'Greater Cairo')) {
  await call('POST', `${S}/shipping`, {
    name: 'Greater Cairo',
    nameAr: 'القاهرة الكبرى',
    areas: ['Cairo', 'Giza'],
    areasAr: ['القاهرة', 'الجيزة'],
    deliveryFee: 5000,
    estimatedDaysMin: 1,
    estimatedDaysMax: 3,
    isActive: true,
  });
}
log({ step: 'shipping', ok: true });

await call('PUT', `/onboarding/stores/${store.id}/payment-methods`, {
  cod: true,
  instapay: { enabled: true, handle: 'qa-launch@instapay' },
});
log({ step: 'payments', ok: true });

if (store.status !== 'active') {
  // Go-live needs a billing method for Ebda's own plan: InstaPay = a payment reference only, nothing is charged.
  await call('POST', `${S}/billing/payment-method`, { method: 'instapay' });
  await call('POST', `/onboarding/stores/${store.id}/go-live`);
}
log({ step: 'go-live', ok: true, url: `https://${SLUG}.ebda.app` });
