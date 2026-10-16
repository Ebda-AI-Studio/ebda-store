#!/usr/bin/env node
/**
 * SP4 Stage 1 exit test (docs/ebda/design/cloudflare-backend.md section 8):
 * N concurrent mixed requests across 2 stores against `wrangler dev`, backed by local Postgres
 * through pgbouncer in TRANSACTION mode, with the API as the non-bypass role `ebda_app`.
 * Asserts 0 errors and 0 cross-tenant leaks.
 *
 *   bash apps/api/scripts/cf-pooler.sh start
 *   su postgres -c "psql -d ebda_s1 -f apps/api/scripts/cf-seed.sql"
 *   (node scripts/cf-api-local-config.mjs && cd apps/api && npx wrangler dev --port 8799 --config .wrangler.local.jsonc)
 *   node apps/api/scripts/stage1-exit-test.mjs [--n 200] [--rounds 3] [--base http://127.0.0.1:8799]
 *
 * The mix (default 200): catalogue reads of store A and B selected by the HOST header
 * (`x-store-domain`), cart writes for both, HOSTILE cart writes (store A's host with store B's
 * product id, which must be refused), and a replayed payment webhook (valid HMAC, one
 * idempotency key). Every request carries its own `cf-connecting-ip` (the Worker turns it into
 * X-Forwarded-For), i.e. a distinct client, so the per-IP limiters do not mask the result.
 * A separate step proves the Durable Object limiter does trip for ONE client (auth: 15 / 15 min).
 *
 * Exit code 0 only when: every expected status matched, no catalogue response contained the
 * other store's rows, no hostile write succeeded, and the database holds no cart item whose
 * product belongs to a different store than its cart.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, Agent } from 'node:http';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('base', 'http://127.0.0.1:8799');
const N = Number(arg('n', '200'));
const ROUNDS = Number(arg('rounds', '3'));
const OUT = arg('out', '');
// Launch spacing: all N requests are still IN FLIGHT together (each takes seconds); a 200-socket
// burst in one tick makes `wrangler dev`'s proxy worker reset connections (a dev-server artefact).
// Pause between rounds so each is a fresh burst, not a continuation of the previous one's teardown.
const PAUSE_MS = Number(arg('pause-ms', '3000'));
const NO_WEBHOOK = process.argv.includes('--no-webhook');
// Soak mode (SP4 Stage 2): `--conc C` runs each round's N requests through a pool of C in flight
// instead of all at once (`--n 1000 --rounds 1 --conc 25` is the 1,000-request soak).
const CONC = Number(arg('conc', '0'));
// `--stats` reads the Worker's dev-only /__dev/stats (needs DEV_STATS=1) after every round: clients
// built vs the pool maximum, and leases still held (must be 0 when idle: a leak otherwise).
const STATS = process.argv.includes('--stats');
const STAGGER_MS = Number(arg('stagger-ms', '4'));
const DB = arg('db', 'ebda_s1');
const WEBHOOK_SECRET = process.env.TAP_WEBHOOK_SECRET || 'dev-only-tap-webhook-secret';

// The API sends `payment/webhook.received` to Inngest (dev mode: http://localhost:8288). A stand-in
// that accepts events keeps the run about the Worker, not about a missing external service.
const inngestMock = createServer((req, res) => {
  req.resume();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ids: [randomUUID()], status: 200 }));
});
await new Promise(resolve => inngestMock.listen(8288, '127.0.0.1', resolve)).catch(() => undefined);
inngestMock.on('error', () => undefined);

const A = { id: '11111111-1111-4111-8111-111111111111', host: 'alpha.ebda.app', tag: 'ALPHA' };
const B = { id: '22222222-2222-4222-8222-222222222222', host: 'bravo.ebda.app', tag: 'BRAVO' };
const other = s => (s === A ? B : A);

function psql(sql) {
  const base = ['-d', DB, '-tA', '-F', '|', '-c', sql];
  const r =
    process.getuid?.() === 0
      ? spawnSync('su', ['postgres', '-c', `psql ${base.map(a => JSON.stringify(a)).join(' ')}`], {
          encoding: 'utf8',
        })
      : spawnSync('psql', base, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => l.split('|'));
}

const products = Object.fromEntries(
  [A, B].map(s => [
    s.tag,
    psql(`select id, slug from products where store_id='${s.id}' order by slug`).map(
      ([id, slug]) => ({ id, slug })
    ),
  ])
);
if (products.ALPHA.length < 3 || products.BRAVO.length < 3) {
  console.error('seed first: su postgres -c "psql -d ebda_s1 -f apps/api/scripts/cf-seed.sql"');
  process.exit(2);
}

let ipSeq = 0;
const nextIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

// One short-lived connection per request (no keep-alive pool): `wrangler dev`'s proxy worker drops
// reused sockets under 200-way concurrency, which is a dev-server artefact, not the API's.
const agent = new Agent({ keepAlive: false, maxSockets: Infinity });

function send(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
        agent,
        timeout: timeoutMs,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function call(kind, store, path, { method = 'GET', body, headers = {} } = {}) {
  const t0 = performance.now();
  let status = 0;
  let json;
  let err;
  try {
    const payload =
      body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const res = await send(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': nextIp(),
        ...(store ? { 'x-store-domain': store.host } : {}),
        ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      body: payload,
      timeoutMs: 60_000,
    });
    status = res.status;
    try {
      json = JSON.parse(res.text);
    } catch {
      json = undefined;
    }
  } catch (e) {
    err = String(e);
  }
  return { kind, store, status, json, err, ms: performance.now() - t0 };
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** Build one round of N requests (mix: 40% catalogue, 30% cart, 5% hostile, 10% webhook, rest detail). */
function buildRound(round) {
  const jobs = [];
  const run = Date.now().toString(36) + round;
  const webhookBody = JSON.stringify({
    id: `chg_exit_${run}`,
    object: 'charge',
    status: 'CAPTURED',
    amount: 10,
    reference: { order: 'ORD-EXIT-NONE' },
  });
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(webhookBody).digest('hex');
  for (let i = 0; i < N; i++) {
    const store = i % 2 === 0 ? A : B;
    const mod = i % 20;
    if (mod < 8) {
      const limit = 3 + (i % 17);
      jobs.push(() => call('catalogue', store, `/api/v1/public/products?limit=${limit}&page=1`));
    } else if (mod < 10) {
      const p = products[store.tag][i % products[store.tag].length];
      jobs.push(() =>
        call('detail', store, `/api/v1/public/products/${encodeURIComponent(p.slug)}`)
      );
    } else if (mod < 16) {
      const p = products[store.tag][i % products[store.tag].length];
      jobs.push(() =>
        call('cart', store, '/api/v1/public/cart/items', {
          method: 'POST',
          headers: { 'x-session-id': `exit-${run}-${i}-${randomUUID().slice(0, 8)}` },
          body: { productId: p.id, quantity: 1 },
        })
      );
    } else if (mod < 17) {
      // HOSTILE: this store's host, the OTHER store's product. Must be refused.
      const p = products[other(store).tag][i % products[other(store).tag].length];
      jobs.push(() =>
        call('hostile', store, '/api/v1/public/cart/items', {
          method: 'POST',
          headers: { 'x-session-id': `exit-h-${run}-${i}-${randomUUID().slice(0, 8)}` },
          body: { productId: p.id, quantity: 1 },
        })
      );
    } else if (mod < 19 && !NO_WEBHOOK) {
      jobs.push(() =>
        call('webhook', null, '/api/v1/webhooks/payment/tap', {
          method: 'POST',
          headers: { 'x-signature': sig },
          body: webhookBody,
        })
      );
    } else {
      jobs.push(() => call('health', null, '/health'));
    }
  }
  return { jobs, idempotencyKey: `tap_chg_exit_${run}` };
}

function judge(r) {
  const problems = [];
  const leaks = [];
  if (r.err) problems.push(`transport: ${r.err}`);
  switch (r.kind) {
    case 'catalogue':
    case 'detail': {
      if (r.status !== 200) problems.push(`status ${r.status}`);
      const list =
        r.kind === 'catalogue' ? r.json?.data?.products : [r.json?.data?.product ?? r.json?.data];
      if (!Array.isArray(list) || list.length === 0 || list.some(p => !p))
        problems.push('empty or malformed');
      else
        for (const p of list) {
          if (p.storeId !== r.store.id || !String(p.name).startsWith(r.store.tag))
            leaks.push(`${r.store.tag} read returned ${p.storeId} ${p.name}`);
        }
      break;
    }
    case 'cart': {
      if (r.status !== 200) problems.push(`status ${r.status}`);
      const cart = r.json?.data?.cart;
      if (!cart) problems.push('no cart');
      else {
        if (cart.storeId !== r.store.id)
          leaks.push(`cart of ${cart.storeId} returned for ${r.store.tag}`);
        for (const it of cart.items ?? [])
          if (it.product?.storeId !== r.store.id)
            leaks.push(`cart item of ${it.product?.storeId} in ${r.store.tag} cart`);
      }
      break;
    }
    case 'hostile':
      if (r.status >= 200 && r.status < 300)
        leaks.push(`hostile cross-store cart write ACCEPTED (${r.status}) for ${r.store.tag}`);
      else if (r.status !== 404 && r.status !== 400)
        problems.push(`hostile write answered ${r.status}, expected 404/400`);
      break;
    case 'webhook':
      if (r.status !== 200) problems.push(`status ${r.status}`);
      break;
    case 'health':
      if (r.status !== 200 || r.json?.status !== 'ok') problems.push(`status ${r.status}`);
      break;
  }
  return { problems, leaks };
}

async function limiterProof() {
  // ONE client (fixed cf-connecting-ip) and ONE email against the login route: the lockout counter
  // (5 wrong passwords) and the auth limiter (15 / 15 min per IP + email) both live in the AuthState
  // Durable Object, so both must trip, from whichever isolate serves the request. Not part of the 200.
  const ip = `10.${200 + (Date.now() % 50)}.${Date.now() % 250}.${Math.floor(Math.random() * 250)}`;
  const email = `nobody-${Date.now()}@exit-test.invalid`;
  const out = [];
  for (let i = 0; i < 18; i++) {
    out.push(
      await call('limiter', null, '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip },
        body: { email, password: 'not-a-real-password' },
      })
    );
  }
  const code = r => r.json?.error?.code;
  return {
    sent: out.length,
    invalidCredentials: out.filter(r => code(r) === 'INVALID_CREDENTIALS').length,
    accountLocked: out.filter(r => code(r) === 'ACCOUNT_LOCKED').length,
    rateLimited: out.filter(r => code(r) === 'RATE_LIMITED').length,
    firstRateLimitedAt: out.findIndex(r => code(r) === 'RATE_LIMITED') + 1,
    firstLockedAt: out.findIndex(r => code(r) === 'ACCOUNT_LOCKED') + 1,
  };
}

function dbLeaks(idempotencyKeys) {
  const crossItems = psql(
    `select count(*) from cart_items ci join carts c on c.id = ci.cart_id join products p on p.id = ci.product_id where p.store_id <> c.store_id`
  )[0][0];
  const inbox = psql(
    `select idempotency_key, count(*) from webhook_events where idempotency_key in (${idempotencyKeys.map(k => `'${k}'`).join(',')}) group by 1`
  );
  return {
    crossStoreCartItems: Number(crossItems),
    inbox: Object.fromEntries(inbox.map(([k, c]) => [k, Number(c)])),
  };
}

const report = { base: BASE, concurrency: N, rounds: [] };
let failed = false;
console.log(`exit test: ${ROUNDS} round(s) x ${N} concurrent requests -> ${BASE}`);

for (let round = 0; round < ROUNDS; round++) {
  if (round > 0) await new Promise(r => setTimeout(r, PAUSE_MS));
  const { jobs, idempotencyKey } = buildRound(round);
  const t0 = performance.now();
  let results;
  if (CONC > 0) {
    results = new Array(jobs.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: CONC }, async () => {
        while (next < jobs.length) {
          const i = next++;
          results[i] = await jobs[i]();
        }
      })
    );
  } else {
    results = await Promise.all(
      jobs.map(async (j, i) => {
        if (STAGGER_MS > 0) await new Promise(r => setTimeout(r, i * STAGGER_MS));
        return j();
      })
    );
  }
  const wall = performance.now() - t0;

  const byKind = {};
  let errors = 0;
  const leaks = [];
  const problems = [];
  for (const r of results) {
    const j = judge(r);
    (byKind[r.kind] ??= []).push(r.ms);
    if (j.problems.length) {
      errors++;
      problems.push(`${r.kind}: ${j.problems.join('; ')}`);
    }
    leaks.push(...j.leaks);
  }
  const db = dbLeaks([idempotencyKey]);
  if (db.crossStoreCartItems !== 0)
    leaks.push(`${db.crossStoreCartItems} cart_items point at another store's product`);
  const inboxRows = db.inbox[idempotencyKey] ?? 0;
  const webhookCount = (byKind.webhook ?? []).length;
  if (webhookCount > 0 && inboxRows !== 1)
    problems.push(
      `webhook replay: ${webhookCount} deliveries left ${inboxRows} inbox rows, expected exactly 1`
    );

  const all = results.map(r => r.ms);
  const row = {
    round: round + 1,
    requests: results.length,
    wallMs: Math.round(wall),
    errors: errors + (webhookCount > 0 && inboxRows !== 1 ? 1 : 0),
    leaks: leaks.length,
    p50: Math.round(pct(all, 50)),
    p95: Math.round(pct(all, 95)),
    p99: Math.round(pct(all, 99)),
    max: Math.round(Math.max(...all)),
    byKind: Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [
        k,
        { n: v.length, p50: Math.round(pct(v, 50)), p95: Math.round(pct(v, 95)) },
      ])
    ),
    webhookInboxRows: inboxRows,
    sampleProblems: problems.slice(0, 5),
    sampleLeaks: leaks.slice(0, 5),
  };
  if (STATS) {
    // Let the post-response `waitUntil` releases finish, then read the isolate's counters.
    await new Promise(r => setTimeout(r, 1500));
    try {
      const st = await send(`${BASE}/__dev/stats`, {
        method: 'GET',
        headers: {},
        timeoutMs: 10_000,
      });
      row.isolate = JSON.parse(st.text);
      const pool = row.isolate.pool;
      // Clients built never exceed the pool maximum ...
      if (!pool || pool.created > pool.max) row.errors++;
      // ... and, with every response in, no client is still leased: a lease held while idle is a
      // leaked connection (/__dev/stats itself is not a lease).
      if (pool && (pool.leased !== 0 || pool.waiting !== 0)) row.leaks++;
    } catch (e) {
      row.isolate = { error: String(e) };
      row.errors++;
    }
  }
  report.rounds.push(row);
  console.log(JSON.stringify(row));
  if (row.errors > 0 || row.leaks > 0) failed = true;
}

report.limiter = await limiterProof();
console.log(
  'limiter + lockout proof (one client, one email, 18 logins):',
  JSON.stringify(report.limiter)
);
if (report.limiter.rateLimited === 0 || report.limiter.accountLocked === 0) {
  console.error('FAIL: the DO-backed limiter or account lockout never tripped for a single client');
  failed = true;
}

report.pass = !failed;
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(failed ? 'EXIT TEST FAILED' : 'EXIT TEST PASSED: 0 errors, 0 cross-tenant leaks');
inngestMock.close();
process.exit(failed ? 1 : 0);
