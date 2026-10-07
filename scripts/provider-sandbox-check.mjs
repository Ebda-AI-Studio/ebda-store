#!/usr/bin/env node
/**
 * provider-sandbox-check.mjs <paymob|kashier|fawry> — run the REAL adapter through the full
 * payment flow against the provider's SANDBOX, so verifying a provider (ruling PROVIDERS-2) is
 * one command once sandbox credentials exist.
 *
 * SANDBOX ONLY. The script refuses to start when anything points at live: it always passes
 * mode 'sandbox' to the adapter, refuses a `<PROVIDER>_BASE_URL` override, and refuses keys that
 * look live (Paymob sk_live_/pk_live_). Amounts are 1.00 EGP.
 *
 * Credentials come from env, one variable per catalog field of the provider
 * (packages/shared/src/providers/catalog.ts), named SANDBOX_<PROVIDER>_<FIELD>, where FIELD is the
 * catalog key upper-cased with every non-alphanumeric run replaced by `_`:
 *
 *   paymob   SANDBOX_PAYMOB_SECRETKEY  SANDBOX_PAYMOB_PUBLICKEY  SANDBOX_PAYMOB_APIKEY
 *            SANDBOX_PAYMOB_HMACSECRET SANDBOX_PAYMOB_INTEGRATIONID_CARD (+ _WALLET, _VALU, _KIOSK)
 *   kashier  SANDBOX_KASHIER_MERCHANTID SANDBOX_KASHIER_PAYMENTAPIKEY SANDBOX_KASHIER_SECRETKEY
 *   fawry    SANDBOX_FAWRY_MERCHANTCODE SANDBOX_FAWRY_SECUREKEY
 *
 * Steps (each printed PASS / FAIL / TODO):
 *   1. testConnection                    (the harmless call the admin's Test connection makes)
 *   2. createPayment 1.00 EGP             prints the hosted page / reference code
 *   3. you pay it with the provider's documented TEST card / wallet / staging tool
 *   4. getStatus polls until paid         (SANDBOX_POLL_SECONDS, default 300)
 *   5. webhook verified                   pass the captured delivery with --webhook <file.json>:
 *                                         {"rawBody": "...", "headers": {...}, "query": {...}}
 *                                         (capture it at a request bin you set as the webhook URL)
 *   6. partial refund 0.40 EGP, then refund of the rest
 *   7. getStatus says refunded
 *
 * Output: a sanitized record (no secret, no PII: ids and amounts only) is written to
 * tests/contracts/<provider>/sandbox-run-<timestamp>.json. Only a run where EVERY step passed is
 * evidence to flip `verified: true` and set `verification.sandboxVerifiedAt` in the catalog.
 *
 * Needs the built API and shared packages: `npm run build -w packages/shared -w apps/api`.
 *
 * SHIPPING CARRIERS (bosta | shipblu | mylerz | aramex): same command, a different flow (read-only
 * steps by default, `--create` books ONE sandbox parcel after a prompt). See
 * scripts/lib/carrier-sandbox-check.mjs for the env variables and the steps.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CARRIER_ADAPTERS, runCarrierCheck } from './lib/carrier-sandbox-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provider = process.argv[2];
const webhookArgIdx = process.argv.indexOf('--webhook');
const webhookFile = webhookArgIdx > 0 ? process.argv[webhookArgIdx + 1] : undefined;
const ADAPTERS = {
  paymob: ['paymob.provider.js', 'createPaymobProvider'],
  kashier: ['kashier.provider.js', 'createKashierProvider'],
  fawry: ['fawry.provider.js', 'createFawryProvider'],
};

function die(msg) {
  console.error(`provider-sandbox-check: ${msg}`);
  process.exit(2);
}

if (CARRIER_ADAPTERS[provider]) {
  await runCarrierCheck({ ROOT, carrier: provider, die, argv: process.argv });
  process.exit(0);
}
if (!ADAPTERS[provider]) {
  die(
    'usage: provider-sandbox-check.mjs <paymob|kashier|fawry|bosta|shipblu|mylerz|aramex> [--create] [--webhook file.json]'
  );
}
if (process.env[`${provider.toUpperCase()}_BASE_URL`]) {
  die(
    `${provider.toUpperCase()}_BASE_URL is set: this script talks to the real sandbox only; unset it.`
  );
}
// The adapters honour base-URL overrides only outside production; make sure none can apply.
process.env.NODE_ENV = 'production';
delete process.env.PAYMENT_PROVIDER_STUB;

const distAdapter = path.join(
  ROOT,
  'apps/api/dist/services/payment-providers',
  ADAPTERS[provider][0]
);
const distShared = path.join(ROOT, 'packages/shared/dist/index.js');
for (const f of [distAdapter, distShared]) {
  if (!fs.existsSync(f))
    die(`missing ${path.relative(ROOT, f)}: run npm run build -w packages/shared -w apps/api`);
}
const shared = await import(pathToFileURL(distShared).href);
const entry = shared.getProviderEntry(provider);
const envName = key =>
  `SANDBOX_${provider.toUpperCase()}_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

// Catalog fields -> adapter slots (the same `bind` the API uses).
const creds = { mode: 'sandbox', settings: {} };
const missing = [];
for (const field of entry.fields) {
  const raw = process.env[envName(field.key)];
  if (!raw) {
    if (field.required) missing.push(envName(field.key));
    continue;
  }
  const value = field.type === 'integer' ? Number(raw) : raw;
  if (field.bind.startsWith('settings.')) {
    const parts = field.bind.split('.').slice(1);
    let node = creds.settings;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)] = value;
  } else creds[field.bind] = String(value);
}
if (missing.length) die(`missing env: ${missing.join(', ')}`);
if (provider === 'paymob') {
  const live = [creds.apiKey, creds.settings.publicKey].some(k => /_live_/.test(String(k ?? '')));
  if (live) die('a Paymob key looks LIVE (sk_live_/pk_live_): refusing. Use test-mode keys.');
}

const mod = await import(pathToFileURL(distAdapter).href);
const adapter = mod[ADAPTERS[provider][1]]({ timeoutMs: 30_000 });
const steps = [];
const record = { provider, startedAt: new Date().toISOString(), steps };
const step = (name, status, info = {}) => {
  steps.push({ name, status, ...info });
  console.log(
    `${status.padEnd(4)} ${name}${Object.keys(info).length ? ` ${JSON.stringify(info)}` : ''}`
  );
};
const errInfo = e => ({
  error: e?.code ?? 'ERROR',
  message: String(e?.message ?? e).slice(0, 200),
});

// 1. Test connection
const conn = await adapter.testConnection(creds);
step('testConnection', conn.ok ? 'PASS' : 'FAIL', { code: conn.code });
if (!conn.ok) finish();

// 2. Create a 1.00 EGP payment
const run = `ebda-sbx-${Date.now().toString(36)}`;
let created;
try {
  created = await adapter.createPayment(
    {
      orderId: run,
      orderNumber: run,
      amountMinor: 100,
      currency: 'EGP',
      customer: { name: 'Sandbox Check', email: 'sandbox-check@ebda.app', phone: '01000000000' },
      returnUrls: {
        success: 'https://ebda.app/checkout/success',
        failure: 'https://ebda.app/checkout/error',
      },
      webhookUrl: process.env.SANDBOX_WEBHOOK_URL,
      idempotencyKey: run,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    creds
  );
  step('createPayment', 'PASS', {
    providerRef: created.providerRef,
    instruction: created.instruction.kind,
  });
} catch (e) {
  step('createPayment', 'FAIL', errInfo(e));
  finish();
}
const where =
  created.instruction.kind === 'reference-code'
    ? `reference code ${created.instruction.code}`
    : created.instruction.url;
console.log(`\nPay it with the provider's TEST card / wallet / staging tool:\n  ${where}\n`);

// 3-4. Poll until paid
const deadline = Date.now() + Number(process.env.SANDBOX_POLL_SECONDS ?? 300) * 1000;
let status;
while (Date.now() < deadline) {
  try {
    status = await adapter.getStatus(created.providerRef, creds);
    if (status.status === 'completed') break;
  } catch (e) {
    status = { status: `error:${errInfo(e).error}` };
  }
  await new Promise(r => setTimeout(r, 5000));
}
step('paid (getStatus)', status?.status === 'completed' ? 'PASS' : 'FAIL', {
  status: status?.status,
});

// 5. Webhook
if (webhookFile) {
  try {
    const w = JSON.parse(fs.readFileSync(webhookFile, 'utf8'));
    const headers = { ...(w.headers ?? {}) };
    if (provider === 'paymob' && w.query?.hmac) headers['x-paymob-hmac'] = w.query.hmac;
    const ev = adapter.verifyWebhook(w.rawBody, headers, creds);
    step('webhook verified', ev.providerRef === created.providerRef ? 'PASS' : 'FAIL', {
      kind: ev.kind,
      status: ev.status,
      amountMinor: ev.amountMinor,
      matchesPayment: ev.providerRef === created.providerRef,
    });
    record.webhookShape = Object.keys(JSON.parse(w.rawBody));
  } catch (e) {
    step('webhook verified', 'FAIL', errInfo(e));
  }
} else {
  step('webhook verified', 'TODO', { hint: 're-run with --webhook <captured delivery json>' });
}

// 6-7. Refunds (partial, then the rest)
if (status?.status === 'completed') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const go = (
    await rl.question('Refund the 1.00 EGP sandbox payment now (0.40 then the rest)? [y/N] ')
  ).trim();
  rl.close();
  if (/^y/i.test(go)) {
    try {
      const p = await adapter.partialRefund(
        {
          providerRef: created.providerRef,
          amountMinor: 40,
          idempotencyKey: `${run}:r1`,
          reason: 'sandbox check',
        },
        creds
      );
      step('partialRefund 40', 'PASS', {
        status: p.status,
        refundedTotalMinor: p.refundedTotalMinor,
      });
      const r = await adapter.refund(
        { providerRef: created.providerRef, idempotencyKey: `${run}:r2`, reason: 'sandbox check' },
        creds
      );
      step('refund rest', 'PASS', { status: r.status, refundedTotalMinor: r.refundedTotalMinor });
      const after = await adapter.getStatus(created.providerRef, creds);
      step('refunded (getStatus)', after.status === 'refunded' ? 'PASS' : 'FAIL', {
        status: after.status,
      });
    } catch (e) {
      step('refunds', 'FAIL', errInfo(e));
    }
  } else step('refunds', 'TODO', { hint: 'not confirmed' });
}
finish();

function finish() {
  record.finishedAt = new Date().toISOString();
  record.allPassed = steps.length >= 7 && steps.every(s => s.status === 'PASS');
  const dir = path.join(ROOT, 'tests/contracts', provider);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `sandbox-run-${record.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `\n${record.allPassed ? 'ALL STEPS PASSED' : 'NOT VERIFIED'}: record written to ${path.relative(ROOT, out)}`
  );
  process.exit(record.allPassed ? 0 : 1);
}
