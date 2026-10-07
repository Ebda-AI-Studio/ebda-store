/**
 * Shipping half of scripts/provider-sandbox-check.mjs (ruling PROVIDERS-2: a carrier flips to
 * `verified: true` only with the evidence this script writes).
 *
 *   node scripts/provider-sandbox-check.mjs <bosta|shipblu|mylerz|aramex> [--create] [--webhook f.json]
 *
 * SANDBOX ONLY. The REAL adapter is driven with `settings.sandbox = true`; the script refuses to
 * start when a live host is configured, and it never creates anything unless `--create` is given
 * AND the operator types `y` at the prompt (a sandbox parcel is still a parcel: it is created with
 * COD 1.00 EGP, a fake receiver and a reference `ebda-sbx-<time>`).
 *
 * Credentials come from env, one variable per catalog field, `SANDBOX_<CARRIER>_<FIELD>` (FIELD =
 * the catalog key upper-cased, non-alphanumerics -> `_`):
 *   bosta    SANDBOX_BOSTA_APIKEY [SANDBOX_BOSTA_BUSINESSLOCATIONID]
 *   shipblu  SANDBOX_SHIPBLU_APIKEY
 *   mylerz   SANDBOX_MYLERZ_USERNAME SANDBOX_MYLERZ_PASSWORD SANDBOX_MYLERZ_WAREHOUSENAME
 *            + SANDBOX_MYLERZ_BASE_URL (Mylerz publishes no sandbox: the host Mylerz gave you)
 *   aramex   SANDBOX_ARAMEX_USERNAME SANDBOX_ARAMEX_PASSWORD SANDBOX_ARAMEX_ACCOUNTNUMBER
 *            SANDBOX_ARAMEX_ACCOUNTPIN SANDBOX_ARAMEX_ACCOUNTENTITY SANDBOX_ARAMEX_ACCOUNTCOUNTRYCODE
 *            + SANDBOX_ARAMEX_BASE_URL (the test host) + SANDBOX_ARAMEX_PRODUCT_TYPE
 * Optional: SANDBOX_<CARRIER>_BASE_URL for any carrier (a staging host), never a known live host.
 *
 * Steps (each PASS / FAIL / TODO): testConnection; quote (read-only, when the carrier has one);
 * with --create: createShipment, idempotent re-create returns the SAME parcel, label (PDF magic
 * bytes), track, webhook (--webhook <file> {body, headers, token}: the captured delivery),
 * cancel (a carrier with no cancel API must answer not_cancellable: the documented manual path).
 * Output: a sanitized record (ids and statuses, no credential, no PII) in
 * tests/contracts/<carrier>/sandbox-run-<timestamp>.json. Only a run where EVERY step passed
 * (including --create) is evidence to flip `verified` in the catalog.
 *
 * Needs the built API and shared packages: `npm run build -w packages/shared -w apps/api`.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const CARRIER_ADAPTERS = {
  bosta: ['bosta.carrier.js', 'bostaCarrier'],
  shipblu: ['shipblu.carrier.js', 'shipbluCarrier'],
  mylerz: ['mylerz.carrier.js', 'mylerzCarrier'],
  aramex: ['aramex.carrier.js', 'aramexCarrier'],
};

/** Hosts that are LIVE for each carrier: a base-URL override pointing at one is refused. */
export const LIVE_HOSTS = {
  bosta: ['app.bosta.co'],
  shipblu: ['api.shipblu.com'],
  mylerz: ['integration.mylerz.net'],
  aramex: ['ws.aramex.net'],
};

export function isLiveHost(carrier, url) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return true; // not a URL: refuse
  }
  return (LIVE_HOSTS[carrier] ?? []).includes(host);
}

export async function runCarrierCheck({ ROOT, carrier, die, argv }) {
  const create = argv.includes('--create');
  const wi = argv.indexOf('--webhook');
  const webhookFile = wi > 0 ? argv[wi + 1] : undefined;
  const upper = carrier.toUpperCase();

  if (process.env[`${upper}_BASE_URL`]) {
    die(
      `${upper}_BASE_URL is set: use SANDBOX_${upper}_BASE_URL (a non-live host) instead; unset it.`
    );
  }
  const sbxBase = process.env[`SANDBOX_${upper}_BASE_URL`];
  if (sbxBase) {
    if (isLiveHost(carrier, sbxBase)) die(`SANDBOX_${upper}_BASE_URL is a LIVE host: refusing.`);
    // the adapters honour a base-URL override only outside production or with CARRIER_STUB=1
    process.env[`${upper}_BASE_URL`] = sbxBase;
    process.env.CARRIER_STUB = '1';
  }
  // NODE_ENV stays as is: the only base-URL override in play is the vetted SANDBOX_<CARRIER>_BASE_URL
  // above (every other <CARRIER>_BASE_URL was refused), and the API's production config demands
  // a full deploy environment that this script must not need.

  const [file, exportName] = CARRIER_ADAPTERS[carrier];
  const distAdapter = path.join(ROOT, 'apps/api/dist/services/carriers', file);
  const distShared = path.join(ROOT, 'packages/shared/dist/index.js');
  for (const f of [distAdapter, distShared]) {
    if (!fs.existsSync(f))
      die(`missing ${path.relative(ROOT, f)}: run npm run build -w packages/shared -w apps/api`);
  }
  const shared = await import(pathToFileURL(distShared).href);
  const entry = shared.getProviderEntry(carrier);
  const envName = key => `SANDBOX_${upper}_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

  const creds = {};
  const missing = [];
  for (const field of entry.fields) {
    const raw = process.env[envName(field.key)];
    if (!raw) {
      if (field.required) missing.push(envName(field.key));
      continue;
    }
    creds[field.key] = raw;
  }
  if (missing.length) die(`missing env: ${missing.join(', ')}`);
  // a webhook secret exists on the real flow; a fixed sandbox one lets the header check run
  creds.webhookSecret = 'sandbox-check-webhook-secret';

  const settings = { sandbox: true };
  if (process.env[`SANDBOX_${upper}_PRODUCT_TYPE`]) {
    settings.productType = process.env[`SANDBOX_${upper}_PRODUCT_TYPE`];
  }
  if (carrier === 'aramex') settings.codEgpConfirmed = true;
  const ctx = {
    settings,
    callbackUrl: `https://api.ebda.app/api/v1/webhooks/shipping/${carrier}/00000000-0000-4000-8000-000000000000/${creds.webhookSecret}`,
  };

  const mod = await import(pathToFileURL(distAdapter).href);
  const adapter = mod[exportName];
  const steps = [];
  const record = { carrier, startedAt: new Date().toISOString(), created: create, steps };
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
  const conn = await adapter.testConnection(creds, ctx);
  step('testConnection', conn.success ? 'PASS' : 'FAIL', {
    code: conn.code ?? (conn.success ? 'ok' : 'unknown'),
  });
  if (!conn.success) return finish();

  const pickup = {
    name: 'Sandbox Store',
    phone: '01000000001',
    line1: '12 Tahrir Street',
    city: 'Cairo',
    state: 'Cairo',
    country: 'EG',
  };
  const dropoff = {
    name: 'Sandbox Check',
    phone: '01000000000',
    email: 'sandbox-check@ebda.app',
    line1: '5 Nile Corniche Street',
    city: 'Giza',
    state: 'Giza',
    area: 'Dokki',
    country: 'EG',
  };

  // 2. Quote (read-only)
  if (adapter.capabilities.quote) {
    try {
      const q = await adapter.quote(
        creds,
        { pickupAddress: pickup, deliveryAddress: dropoff, weight: 0.5, codAmount: 100 },
        ctx
      );
      step('quote', Number.isSafeInteger(q.amountPiastres) ? 'PASS' : 'FAIL', {
        amountPiastres: q.amountPiastres,
      });
    } catch (e) {
      step('quote', 'FAIL', errInfo(e));
    }
  }

  if (!create) {
    step('createShipment', 'TODO', {
      hint: 're-run with --create to book ONE sandbox parcel (COD 1.00 EGP)',
    });
    return finish();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const go = (
    await rl.question(`Book ONE ${carrier} SANDBOX parcel (COD 1.00 EGP, fake receiver)? [y/N] `)
  ).trim();
  rl.close();
  if (!/^y/i.test(go)) {
    step('createShipment', 'TODO', { hint: 'not confirmed' });
    return finish();
  }

  // 3. Create + idempotent re-create
  const run = `ebda-sbx-${Date.now().toString(36)}`;
  const req = {
    orderId: run,
    orderNumber: run,
    merchantReference: run,
    pickupAddress: pickup,
    deliveryAddress: dropoff,
    items: [{ name: 'Sandbox item', quantity: 1, value: 100 }],
    weight: 0.5,
    codAmount: 100,
  };
  let shipment;
  try {
    shipment = await adapter.createShipment(creds, req, ctx);
    step('createShipment', 'PASS', {
      carrierShipmentId: shipment.carrierShipmentId,
      trackingNumber: shipment.trackingNumber,
    });
  } catch (e) {
    step('createShipment', 'FAIL', errInfo(e));
    return finish();
  }
  try {
    const again = await adapter.createShipment(creds, req, ctx);
    const same = again.trackingNumber === shipment.trackingNumber;
    step('idempotent re-create (same reference, same parcel)', same ? 'PASS' : 'FAIL', { same });
  } catch (e) {
    step('idempotent re-create (same reference, same parcel)', 'FAIL', errInfo(e));
  }

  // 4. Label
  if (adapter.capabilities.label) {
    try {
      const label = await adapter.getLabel(creds, shipment, ctx);
      const pdfOk = label.pdfBase64
        ? Buffer.from(label.pdfBase64, 'base64').subarray(0, 4).toString() === '%PDF'
        : Boolean(label.url);
      step('label', pdfOk ? 'PASS' : 'FAIL', { kind: label.pdfBase64 ? 'pdf' : 'url' });
    } catch (e) {
      step('label', 'FAIL', errInfo(e));
    }
  }

  // 5. Track
  try {
    const t = await adapter.trackShipment(creds, shipment.trackingNumber, ctx);
    step('track', t.status ? 'PASS' : 'FAIL', { status: t.status, events: t.statusHistory.length });
  } catch (e) {
    step('track', 'FAIL', errInfo(e));
  }

  // 6. Webhook (carriers that push)
  if (adapter.capabilities.webhooks) {
    if (webhookFile) {
      try {
        const w = JSON.parse(fs.readFileSync(webhookFile, 'utf8'));
        const headers = Object.fromEntries(
          Object.entries(w.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
        );
        const parsed = adapter.processWebhook(w.body, headers);
        const headerOk = adapter.webhookHeader
          ? headers[adapter.webhookHeader.name.toLowerCase()] ===
            adapter.webhookHeader.valueFor(creds.webhookSecret)
          : true;
        step('webhook parsed + header echoed', parsed && headerOk ? 'PASS' : 'FAIL', {
          status: parsed?.status,
          headerOk,
          trackingMatches: parsed?.trackingNumber === shipment.trackingNumber,
        });
        record.webhookShape = Object.keys(w.body ?? {});
      } catch (e) {
        step('webhook parsed + header echoed', 'FAIL', errInfo(e));
      }
    } else {
      step('webhook parsed + header echoed', 'TODO', {
        hint: 're-run with --webhook <captured delivery json {body, headers}>',
      });
    }
  }

  // 7. Cancel (a carrier with no cancel API must say not_cancellable: the documented manual path)
  try {
    const raw = await adapter.cancelShipment(creds, shipment.carrierShipmentId, ctx);
    const c = typeof raw === 'boolean' ? { status: raw ? 'cancelled' : 'failed' } : raw;
    const noApi = ['aramex', 'shipblu'].includes(carrier);
    const ok = noApi ? c.status === 'not_cancellable' : c.status === 'cancelled';
    step(noApi ? 'cancel (no API: manual path)' : 'cancel', ok ? 'PASS' : 'FAIL', {
      status: c.status,
    });
  } catch (e) {
    step('cancel', 'FAIL', errInfo(e));
  }
  return finish();

  function finish() {
    record.finishedAt = new Date().toISOString();
    record.allPassed = create && steps.every(s => s.status === 'PASS');
    const dir = path.join(ROOT, 'tests/contracts', carrier);
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `sandbox-run-${record.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(
      `\n${record.allPassed ? 'ALL STEPS PASSED' : 'NOT VERIFIED'}: record written to ${path.relative(ROOT, out)}`
    );
    process.exit(record.allPassed ? 0 : 1);
  }
}
