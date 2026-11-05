#!/usr/bin/env node
// REAL-RECOVERY step: replay ONE extracted StoreDO dump (restore-drill.mjs --extract) into a StoreDO through the production
// __import path, then __verify it against the manifest. Writes to whatever --api-url points at.
//   node scripts/ops/restore-store-do.mjs --dir <extract dir> --store <uuid> --api-url http://127.0.0.1:8798 [--wipe]
// A non-loopback --api-url (production) additionally needs --i-understand-this-writes-production. --wipe calls __unseal first
// (the DO is emptied and unsealed so the import is a clean restore, not an upsert over live rows). CUTOVER_IMPORT_SECRET is read from the env.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseStoreDump, compareTables } from './lib/cf-backup.mjs';
import { restoreStoreOverHttp, assertLoopback } from './lib/cf-drill.mjs';

const { values: a } = parseArgs({
  options: {
    dir: { type: 'string' },
    store: { type: 'string' },
    'api-url': { type: 'string' },
    wipe: { type: 'boolean', default: false },
    'i-understand-this-writes-production': { type: 'boolean', default: false },
  },
});
if (!a.dir || !a.store || !a['api-url'])
  throw new Error('--dir, --store and --api-url are required');
try {
  assertLoopback(a['api-url']);
} catch (e) {
  if (!a['i-understand-this-writes-production'])
    throw new Error(
      `${e.message}; pass --i-understand-this-writes-production to write to production`
    );
}
const secret = process.env.CUTOVER_IMPORT_SECRET;
if (!secret || secret.length < 24)
  throw new Error('CUTOVER_IMPORT_SECRET (24+ chars, set on the Worker) is required');
const manifest = JSON.parse(readFileSync(path.join(a.dir, 'manifest.json'), 'utf8'));
const entry = manifest.artifacts[`do-${a.store}`];
if (!entry) throw new Error(`no do-${a.store} in the manifest`);
const post = async (p, body, ctype) => {
  const res = await fetch(a['api-url'] + p, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': ctype },
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${j.error ?? ''}`);
  return j;
};
if (a.wipe)
  await post(
    `/cutover/stores/${a.store}/__unseal`,
    JSON.stringify({ confirm: 'wipe-and-unseal' }),
    'application/json'
  );
const dump = parseStoreDump(readFileSync(path.join(a.dir, `do-${a.store}.${entry.ext}`), 'utf8'));
const get = async p => {
  const res = await fetch(a['api-url'] + p, { headers: { authorization: `Bearer ${secret}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${j.error ?? ''}`);
  return j;
};
const res = await restoreStoreOverHttp(post, a.store, dump, `restore-${manifest.day}`, get);
const bad = compareTables(entry.tables, res.tables).filter(c => !c.ok);
console.log(
  bad.length || res.fk?.violations
    ? `FAIL ${JSON.stringify({ bad, fk: res.fk })}`
    : `OK ${dump.length} tables restored and equal to the manifest`
);
process.exit(bad.length || res.fk?.violations ? 1 : 0);
