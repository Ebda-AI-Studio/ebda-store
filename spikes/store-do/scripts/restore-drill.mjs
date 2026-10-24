// Restore drill against the production worker's flagged demo store (Task 0.6).
//   BASE=https://api.ebda.app SEED_TOKEN=... node scripts/restore-drill.mjs --store-id <uuid>
// 1. POST backup (exports to R2 under store-do-backups/<store>/<day>/), 2. restore that day into a FRESH DO instance
// (never the live one), 3. the DO re-exports itself and compares row counts + sha256 per table with the manifest.
import { randomBytes } from 'node:crypto';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const base = (process.env.BASE ?? 'https://api.ebda.app').replace(/\/$/, '');
const storeId = arg('store-id');
if (!storeId || !process.env.SEED_TOKEN) throw new Error('--store-id and SEED_TOKEN required');
const h = { authorization: `Bearer ${process.env.SEED_TOKEN}`, 'content-type': 'application/json' };
const call = async (p, init) => {
  const r = await fetch(`${base}/api/v1/internal/store-do/${storeId}${p}`, { headers: h, ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
};
const manifest = await call('/backup', { method: 'POST', body: '{}' });
const day = manifest.takenAt.slice(0, 10);
const res = await call('/restore', {
  method: 'POST',
  body: JSON.stringify({ day, run: randomBytes(6).toString('hex') }),
});
let ok = true;
for (const [t, m] of Object.entries(manifest.tables)) {
  const r = res[t];
  const good = r?.ok && r.rows === m.rows && r.sha256 === m.sha256;
  ok &&= good;
  console.log(
    `${good ? 'PASS' : 'FAIL'}  ${t.padEnd(18)} rows=${m.rows} sha256=${m.sha256.slice(0, 12)}...`
  );
}
let bookmark;
try {
  bookmark = (await call('/bookmark')).bookmark;
} catch (e) {
  bookmark = `error: ${e.message.slice(0, 120)}`;
}
console.log(`pitr bookmark: ${bookmark}`);
console.log(ok ? 'restore: counts equal, checksums equal' : 'restore: MISMATCH');
process.exit(ok ? 0 : 1);
