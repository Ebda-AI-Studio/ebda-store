#!/usr/bin/env node
// SP5 unaided E2E, HTTP only, against any running Ebda API (Node-Express or a Worker):
//   signup -> verify email -> create store (slug) -> template -> first product (EGP) -> enable COD -> go live
//   -> as a storefront customer: add to cart -> checkout (COD) -> order created -> merchant sees the order.
//
//   node scripts/ebda-e2e-self-serve.mjs --api http://127.0.0.1:4816/api/v1 --mail-log /tmp/ev-worker-sp.log [--json out.json]
//
// Outside production the API never sends mail and exposes no outbox over HTTP (platform-mailer.ts): it logs the
// verification link ("[PLATFORM-MAIL] captured"). So the one non-HTTP input is the server's own stdout log,
// `--mail-log` (read from the byte offset the run started at; handles pino-pretty on Node and JSON lines on a
// Worker). Everything else is HTTP. Exit 0 = every step held. Prints wall time per step and in total.
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const API = opt('--api', 'http://127.0.0.1:4000/api/v1').replace(/\/$/, '');
const LOG = opt('--mail-log');
const JSON_OUT = opt('--json');
if (!LOG) {
  console.error(
    '--mail-log <server stdout file> is required (the only place a dev API exposes the verification link)'
  );
  process.exit(2);
}
const run = crypto.randomUUID().slice(0, 8);
const email = `e2e-${run}@test.local`;
const slug = `e2e-${run}`;
const host = `${slug}.ebda.app`;
const PASSWORD = 'Str0ng!Passw0rd';
const MIN_FILL_WAIT_MS = Number(opt('--min-fill-ms', 3200)); // SIGNUP_MIN_FILL_MS default 3000: a real form is never faster

const steps = [];
let failed = false;
async function call(method, path, { body, jwt, host: h, session } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      ...(h ? { 'x-store-domain': h } : {}),
      ...(session ? { 'x-session-id': session } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, data: json?.data, code: json?.error?.code };
}
async function step(name, fn, { waitMs = 0 } = {}) {
  const t = Date.now();
  let note = '';
  let ok = true;
  try {
    note = (await fn()) ?? '';
  } catch (e) {
    ok = false;
    failed = true;
    note = e.message;
  }
  const ms = Date.now() - t;
  steps.push({ step: name, ms, waitMs, ok, note });
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${String(ms).padStart(5)} ms  ${name}${note ? '  - ' + note : ''}`
  );
  if (!ok) throw new Error(`step failed: ${name}`);
}
const must = (r, status, what) => {
  const want = Array.isArray(status) ? status : [status];
  if (!want.includes(r.status))
    throw new Error(
      `${what}: HTTP ${r.status} ${r.code ?? ''} ${JSON.stringify(r.body?.error ?? '').slice(0, 200)}`
    );
  return r;
};

async function linkAfter(fromByte) {
  for (let i = 0; i < 100; i++) {
    const text = fs
      .readFileSync(LOG)
      .subarray(fromByte)
      .toString('utf8')
      .replace(/\x1b\[[0-9;]*m/g, '');
    const all = [...text.matchAll(/verify-email\?token=([0-9a-f]+)/g)];
    if (all.length) return all[all.length - 1][1];
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no [PLATFORM-MAIL] verification link appeared in the server log');
}

const T0 = Date.now();
const logStart = fs.statSync(LOG).size;
let jwt, storeId, productId, orderId, orderNumber;
const session = `sess_${crypto.randomBytes(16).toString('hex')}`;
try {
  await step('health', async () => {
    const r = await fetch(API.replace(/\/api\/v1$/, '/health'));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
  let formToken;
  await step('signup: get form token', async () => {
    formToken = must(await call('GET', '/auth/merchant/signup-token'), 200, 'signup-token').data
      .token;
  });
  await new Promise(r => setTimeout(r, MIN_FILL_WAIT_MS));
  steps.push({
    step: '(anti-bot minimum form-fill wait, not API time)',
    ms: MIN_FILL_WAIT_MS,
    waitMs: MIN_FILL_WAIT_MS,
    ok: true,
    note: '',
  });
  console.log(
    `wait ${String(MIN_FILL_WAIT_MS).padStart(5)} ms  anti-bot minimum fill time (SIGNUP_MIN_FILL_MS), deliberate`
  );
  await step('signup', async () => {
    const r = must(
      await call('POST', '/auth/merchant/signup', {
        body: {
          email,
          password: PASSWORD,
          name: 'E2E Merchant',
          phone: '012 3456 7890',
          formToken,
          acceptedLegal: true,
        },
      }),
      200,
      'signup'
    );
    if (r.data?.emailVerificationSent !== true) throw new Error('emailVerificationSent not true');
  });
  let token;
  await step('read verification token (dev mail capture: server log)', async () => {
    token = await linkAfter(logStart);
    return `token ${token.slice(0, 6)}...`;
  });
  await step('verify email', async () => {
    must(await call('POST', '/auth/verify-email', { body: { token } }), 200, 'verify-email');
  });
  await step('login', async () => {
    jwt = must(
      await call('POST', '/auth/login', { body: { email, password: PASSWORD } }),
      200,
      'login'
    ).data.accessToken;
  });
  await step('create store (slug)', async () => {
    const r = must(
      await call('POST', '/onboarding/store', {
        jwt,
        body: { name: 'E2E Store', nameAr: 'متجر تجريبي', slug, language: 'ar' },
      }),
      201,
      'create store'
    );
    storeId = r.data.store.id;
    return `slug ${slug}, store ${storeId.slice(0, 8)}`;
  });
  await step('choose template', async () => {
    must(
      await call('PUT', `/stores/${storeId}/template`, { jwt, body: { template: 'qamar' } }),
      200,
      'template'
    );
  });
  await step('first product (EGP 199.00 = 19900 piastres)', async () => {
    const r = must(
      await call('POST', `/stores/${storeId}/products`, {
        jwt,
        body: { name: 'E2E Scarf', nameAr: 'وشاح', price: 19900, inventory: 5, status: 'active' },
      }),
      201,
      'product'
    );
    productId = r.data.product?.id ?? r.data.id;
    if (!productId) throw new Error('no product id in response');
  });
  await step('enable cash on delivery', async () => {
    must(
      await call('PUT', `/onboarding/stores/${storeId}/payment-methods`, {
        jwt,
        body: { cod: true },
      }),
      200,
      'payment-methods'
    );
  });
  await step('go live', async () => {
    const r = must(
      await call('POST', `/onboarding/stores/${storeId}/go-live`, { jwt }),
      200,
      'go-live'
    );
    if (r.data.store.status !== 'active' || r.data.store.host !== host)
      throw new Error(`unexpected store ${JSON.stringify(r.data.store)}`);
    return `live at ${host}`;
  });
  await step('storefront: product visible at the store host', async () => {
    const r = must(
      await call('GET', '/public/products?limit=5', { h: undefined, host }),
      200,
      'public products'
    );
    const ps = r.data.products ?? r.data;
    const p = ps.find(x => x.id === productId);
    if (!p || p.price !== 19900) throw new Error('product missing or wrong price');
    return `${ps.length} product, EGP ${(p.price / 100).toFixed(2)}`;
  });
  await step('customer: add to cart', async () => {
    const r = must(
      await call('POST', '/public/cart/items', { host, session, body: { productId, quantity: 2 } }),
      [200, 201],
      'add to cart'
    );
    return `qty 2`;
  });
  let cart;
  await step('customer: read cart + COD config + shipping quote', async () => {
    cart = must(await call('GET', '/public/cart', { host, session }), 200, 'cart').data.cart;
    if (!cart?.items?.length) throw new Error('cart empty');
    must(await call('GET', '/payments/config', { host, session }), 200, 'payments config');
    const q = await call('POST', `/stores/public/${storeId}/shipping/calculate`, {
      host,
      session,
      body: { area: 'Nasr City', governorate: 'Cairo', orderTotal: cart.subtotal },
    });
    return `subtotal ${cart.subtotal} piastres, shipping quote HTTP ${q.status}`;
  });
  await step('customer: checkout (COD) -> order created', async () => {
    const address = {
      firstName: 'Mona',
      lastName: 'Hassan',
      address1: '12 Abbas El Akkad St',
      area: 'Nasr City',
      governorate: 'Cairo',
      city: '',
      country: 'Egypt',
      phone: '+201012345678',
      email: `buyer-${run}@test.local`,
    };
    const r = must(
      await call('POST', '/public/orders', {
        host,
        session,
        body: { shippingAddress: address, paymentMethod: 'cod', notes: '' },
      }),
      [200, 201],
      'create order'
    );
    const o = r.data.order;
    orderId = o.id;
    orderNumber = o.orderNumber;
    const p = must(
      await call('POST', '/payments/create', {
        host,
        session,
        body: {
          orderId,
          provider: 'cod',
          successUrl: `/checkout/success?orderId=${orderId}`,
          errorUrl: `/checkout/error?orderId=${orderId}`,
        },
      }),
      200,
      'payments/create (cod)'
    );
    return `order ${orderNumber}, total ${o.total} piastres, status ${o.status}`;
  });
  await step('merchant sees the order', async () => {
    const r = must(
      await call('GET', `/stores/${storeId}/orders?limit=10`, { jwt }),
      200,
      'merchant orders'
    );
    const list = r.data.orders ?? r.data;
    const found = list.find(o => o.id === orderId);
    if (!found) throw new Error(`order ${orderId} not in merchant list (${list.length} orders)`);
    return `${found.orderNumber} total ${found.total} status ${found.status}`;
  });
  await step('merchant setup guide reflects it', async () => {
    const g = must(
      await call('GET', `/stores/${storeId}/setup-guide`, { jwt }),
      200,
      'setup-guide'
    );
    const done = g.data.items
      .filter(i => i.done)
      .map(i => i.key)
      .join(',');
    return `done: ${done}`;
  });
} catch (e) {
  console.error(String(e.message));
}
const total = Date.now() - T0;
const wait = steps.reduce((a, s) => a + (s.waitMs || 0), 0);
console.log(
  `TOTAL ${total} ms (${(total / 1000).toFixed(1)} s), of which ${wait} ms deliberate anti-bot wait; API+log time ${total - wait} ms`
);
console.log(failed ? 'E2E FAILED' : `E2E PASSED  store ${host}  order ${orderNumber}`);
if (JSON_OUT)
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        api: API,
        slug,
        email,
        host,
        storeId,
        orderId,
        orderNumber,
        totalMs: total,
        waitMs: wait,
        steps,
        passed: !failed,
      },
      null,
      2
    )
  );
process.exit(failed ? 1 : 0);
