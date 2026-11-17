#!/usr/bin/env node
// Generates apps/api/src/cf/erasure/registry.generated.ts (the StoreDO erasure registry) from
// packages/cf-schema/erasure-classification.json + the store migrations (Ruling CF-ERASE-3). CI runs it with --check:
// a classification or schema change that is not regenerated fails the build, so a table can never be added to the DO
// without a decision about its personal data.
//
//   node scripts/cf/gen-erasure-registry.mjs          write the file
//   node scripts/cf/gen-erasure-registry.mjs --check  exit 1 when the committed file differs from the generated one
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PKG = path.join(ROOT, 'packages/cf-schema');
const OUT = path.join(ROOT, 'apps/api/src/cf/erasure/registry.generated.ts');

/** Subject key -> candidate columns, first one the table has. */
const CANDIDATES = {
  email: ['email', 'guest_email', 'customer_email'],
  phone: ['phone', 'customer_phone'],
  userId: ['user_id'],
  buyerKey: ['buyer_key', 'recipient_phone_hash'],
  customerId: ['customer_id'],
};
/** A table that reaches the subject only through its parent order (no customer column of its own). */
const VIA = { shipments: { column: 'order_id', table: 'orders' } };
/**
 * Customer-pii tables the subject cannot be matched in directly. Each must be a child that an FK `ON DELETE CASCADE`
 * removes with a matched parent, or be named here with the reason (the residual is documented in CF-ERASE-3).
 */
const UNKEYED_ALLOWED = {
  affiliate_referrals:
    'holds only an anonymous session id and no subject key; the referrer row and its referrals cascade when the affiliate is erased',
};
/**
 * Tables the StoreDO creates itself at start (ensure* in packages/repo/src/do/*), so they are not in cf-schema and have no
 * classification row. Each was reviewed column by column: neither holds personal data.
 */
const RUNTIME_TABLES = {
  payment_event_log:
    'provider, event_id, payment_id, outcome, applied_at: webhook dedupe keys only',
  vector_usage: 'store_id, day, texts: a per-day embedding counter',
};
/**
 * Runtime tables of the assistant's journal (Smart Layer, Ruling SL-STORE-1; packages/repo do/smart-layer.ts). The text in them is masked by the
 * engine before it is stored (secrets, phones, e-mails, cards), they hold the merchant's own conversation and preview rows, no customer subject
 * key: they are store-owned, retained 90 days and removed with the store (and per merchant user by `scrubUserFromStoreDo` (packages/repo/src/platform-erasure.ts, StoreDO.scrubActor), and a shopper's name by eraseShopper).
 */
const RUNTIME_STORE_OWNED = {
  sl_turns: 'the merchant\'s own masked assistant messages',
  sl_audit: 'one masked audit row per assistant turn',
  sl_previews: 'previews of a change (before/after labels of the merchant\'s own data)',
  sl_applied: 'what an applied assistant change did and its inverse',
  sl_approvals: 'server-issued single-use approvals (token hash only)',
  sl_decisions: 'who pressed confirm or reject',
  sl_counters: 'sliding-window rate-limit hits, no content',
};
/**
 * Runtime tables (as above) that DO hold a buyer's personal data: classified here with the same shape a schema table gets.
 * `instapay_order_receipts` (Ruling INSTAPAY-DO-1): the payer's typed / AI-read fields on a receipt, reached through the order.
 */
const RUNTIME_PII_TABLES = {
  instapay_order_receipts: {
    via: { column: 'order_id', table: 'orders' },
    action: 'scrub',
    scrub: {
      payer_name: null,
      payer_address: null,
      payer_mobile: null,
      payer_bank: null,
      receiver_name: null,
      receiver_handle: null,
      receiver_mobile: null,
      note: null,
      extracted: null,
    },
  },
};
RUNTIME_PII_TABLES.erasure_ledger = {
  // Ruling CF-R6A-3: the saved scope of a shopper erasure (order ids, buyer keys, receipt ids), keyed by the user id; a
  // customer erasure of the same subject deletes it, and a 30-day TTL bounds a half-finished one
  match: { userId: 'user_id' },
  action: 'delete',
};
const PII_JSON_LIKE = /address|_raw|json/i;

export async function generate() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(PKG, 'migrations/store');
  for (const f of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  const cls = JSON.parse(fs.readFileSync(path.join(PKG, 'erasure-classification.json'), 'utf8'));

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all()
    .map(r => r.name);
  const entries = {};
  for (const [id, e] of Object.entries(cls)) if (e.db === 'store-do') entries[id.split(':')[1]] = e;
  const missing = tables.filter(t => !entries[t]);
  const extra = Object.keys(entries).filter(t => !tables.includes(t));
  if (missing.length || extra.length)
    throw new Error(`classification and schema disagree: unclassified=${missing} unknown=${extra}`);

  const out = {};
  for (const t of tables) {
    const e = entries[t];
    if (e.class === 'no-pii') {
      out[t] = { kind: 'no-pii' };
      continue;
    }
    if (e.class !== 'customer-pii') {
      out[t] = { kind: 'store-owned' }; // merchant-pii / legal-retention: goes with the store, never with a customer subject
      continue;
    }
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all();
    const match = {};
    for (const k of e.subjectKeys) {
      const col = (CANDIDATES[k] ?? []).find(c => byName[c]);
      if (col) match[k] = col;
    }
    const via = VIA[t];
    // a key with no column here is fine only when the table is still reached (another key, or the parent order)
    if (!Object.keys(match).length && !via) {
      const cascade = fks.some(f => f.on_delete === 'CASCADE');
      if (!UNKEYED_ALLOWED[t] && !cascade)
        throw new Error(
          `${t}: customer-pii table with no matchable subject column and no cascading parent`
        );
    }
    const entry = { kind: 'customer-pii', match, action: e.action };
    if (via) entry.via = via;
    if (e.action === 'scrub') {
      const scrub = {};
      for (const c of e.piiColumns) {
        if (c === '*') throw new Error(`${t}: scrub with '*'`);
        const col = byName[c];
        if (!col) throw new Error(`${t}.${c} is not a column`);
        if (!col.notnull) scrub[c] = null;
        else if (/TEXT/i.test(col.type)) scrub[c] = PII_JSON_LIKE.test(c) ? '{}' : '[erased]';
        else throw new Error(`${t}.${c}: NOT NULL ${col.type} has no scrub value`);
      }
      for (const col of Object.values(match))
        if (!(col in scrub))
          throw new Error(
            `${t}: match column ${col} is not scrubbed (row would still identify the buyer)`
          );
      entry.scrub = scrub;
    }
    out[t] = entry;
  }
  for (const t of Object.keys(RUNTIME_TABLES)) {
    if (out[t]) throw new Error(`${t} is now in the schema: drop it from RUNTIME_TABLES`);
    out[t] = { kind: 'no-pii' };
  }
  for (const t of Object.keys(RUNTIME_STORE_OWNED)) {
    if (out[t]) throw new Error(`${t} is now in the schema: drop it from RUNTIME_STORE_OWNED`);
    out[t] = { kind: 'store-owned' };
  }
  for (const [t, e] of Object.entries(RUNTIME_PII_TABLES)) {
    if (out[t]) throw new Error(`${t} is now in the schema: drop it from RUNTIME_PII_TABLES`);
    out[t] = {
      kind: 'customer-pii',
      match: e.match ?? {},
      via: e.via,
      action: e.action,
      scrub: e.scrub,
    };
  }
  // Merchant erasure (Ruling NZ-D16): the merchant-pii tables and the columns to anonymise IN PLACE (never a row delete, never a
  // `retain` table). Every listed column must exist, so a schema change cannot silently skip one.
  const merchantPlan = [];
  for (const t of tables) {
    const e = entries[t];
    if (e.class !== 'merchant-pii' || e.action === 'retain' || !e.piiColumns?.length) continue;
    const names = new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name));
    for (const c of e.piiColumns)
      if (!names.has(c)) throw new Error(`${t}.${c} (merchant-pii) is not a column`);
    merchantPlan.push({ table: t, columns: [...e.piiColumns] });
  }
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = JSON.stringify(sorted, null, 2)
    .replace(/"([a-z_A-Z][a-zA-Z_0-9]*)":/g, '$1:')
    .replace(/"/g, "'");
  const text = `// GENERATED by scripts/cf/gen-erasure-registry.mjs from packages/cf-schema/erasure-classification.json + the store
// migrations (Ruling CF-ERASE-3). Do not edit: change the classification and run \`npm run cf:erasure-registry\`.
// CI (\`--check\`) fails when this file is stale.
import type { TableClass } from './registry';

export const GENERATED_STORE_DO_REGISTRY: Record<string, TableClass> = ${body};

export const GENERATED_MERCHANT_PII_PLAN: Array<{ table: string; columns: string[] }> = ${JSON.stringify(merchantPlan).replace(/"([a-z_A-Z][a-zA-Z_0-9]*)":/g, '$1:').replace(/"/g, "'")};
`;
  // formatted with the repo's own prettier config so the committed file is a fixed point of lint-staged
  const prettier = await import('prettier');
  return prettier.format(text, { ...(await prettier.resolveConfig(OUT)), filepath: OUT });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await generate();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== text) {
      console.error(
        'erasure registry is stale: run `npm run cf:erasure-registry` and commit the result'
      );
      process.exit(1);
    }
    console.log('erasure registry is current');
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${path.relative(ROOT, OUT)}`);
  }
}
