#!/usr/bin/env node
// OFF-ACCOUNT copy of the nightly backup (Ruling ICEBERG-BK-3). cf-backup.yml writes D1 ebda-platform + ebda-identity + every
// StoreDO (age-encrypted) and the R2 ebda-media copy into R2 `ebda-db-backups`, which lives in the SAME Cloudflare account as
// production. This job pulls them to this Mac over the Cloudflare REST API (api.cloudflare.com; workers.dev is ISP-blocked), so
// losing the Cloudflare account does not lose the data. House pattern: backup-all-neon.sh (launchd, local, keeps 30).
//
//   ROOT/objects/<encSha256>                      every encrypted artifact once (content-addressed; reused artifacts cost nothing)
//   ROOT/days/<YYYY-MM-DD>/<name>.<ext>.gz.age    hard links into objects/ + manifest.json; the newest KEEP (30) days are kept
//   ROOT/media/<backupKey> + media/manifest.json  append-only mirror of media/ (never pruned: an image deleted in production stays)
//   ROOT/fiscal-archive/v1/{manifests,data}/      SECOND COPY of the fiscal archive of deleted stores (R2 ebda-private, Ruling
//                                                 FISCAL-ARCHIVE-1): sha256-checked against its manifest, then age-encrypted to the
//                                                 PUBLIC recipient (EBDA_BACKUP_AGE_PUBLIC_KEY or Keychain `ebda-backup-age-public`;
//                                                 no private key here), only .age + index.json kept; NEVER pruned (7-year retention)
//
// Every file is sha256-checked against the backup manifest before it is linked; the newest backup must be <= 2 days old.
// Nothing is decrypted here: the age private key stays in the Keychain, and decryptability is what the restore drill proves.
//
// Env: EBDA_R2_READ_TOKEN (else Keychain item `ebda-r2-backup-read`: a Cloudflare API token with Workers R2 Storage READ only),
// EBDA_CF_ACCOUNT_ID, EBDA_CF_BACKUP_PULL_ROOT (default ~/Desktop/projects/_backups/ebda-cf-encrypted; outside iCloud),
// EBDA_CF_BACKUP_PULL_KEEP (30). Alerts on failure: Telegram if TELEGRAM_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID (or Keychain items
// `ebda-alert-telegram-bot` / `ebda-alert-telegram-chat`) exist, plus a macOS notification; the exit code is non-zero either way.
// Install: bash scripts/ops/install-cf-backup-pull.sh. Manual run: node scripts/ops/pull-cf-backups.mjs
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ACCOUNT_ID = '69188202efc4df480140dd76545aa3ab';
export const BUCKET = 'ebda-db-backups';
export const PRIVATE_BUCKET = 'ebda-private';
export const FISCAL_PREFIX = 'fiscal-archive/v1/';
export const MAX_AGE_DAYS = 2;
const sha256 = b => createHash('sha256').update(b).digest('hex');
const DAY_MS = 86_400_000;

/** get(key) -> Buffer | null. Pure apart from the filesystem under root; returns a report, throws on any integrity failure. */
export async function pullBackups({ get, root, keep = 30, now = new Date(), log = () => {} }) {
  const json = async k => {
    const b = await get(k);
    return b ? JSON.parse(b.toString('utf8')) : null;
  };
  const latest = await json('cf/latest.json');
  if (!latest?.day) throw new Error('cf/latest.json missing: no backup has completed');
  const age = Math.floor(
    (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(latest.day)) / DAY_MS
  );
  if (age > MAX_AGE_DAYS)
    throw new Error(`newest backup is ${latest.day}, ${age} days old (limit ${MAX_AGE_DAYS})`);
  const manifest = await json(`cf/daily/${latest.day}/manifest.json`);
  if (!manifest) throw new Error(`manifest for ${latest.day} missing`);

  const objects = path.join(root, 'objects');
  const dayDir = path.join(root, 'days', latest.day);
  mkdirSync(objects, { recursive: true });
  mkdirSync(dayDir, { recursive: true });
  let downloaded = 0;
  let downloadedBytes = 0;
  const fetchVerified = async (key, want) => {
    const buf = await get(key);
    if (!buf) throw new Error(`${key}: listed in the manifest but missing from the bucket`);
    if (sha256(buf) !== want) throw new Error(`${key}: sha256 differs from the manifest`);
    downloaded++;
    downloadedBytes += buf.length;
    return buf;
  };
  const verifiedLocal = (file, want) => existsSync(file) && sha256(readFileSync(file)) === want;

  const names = Object.keys(manifest.artifacts);
  for (const name of names) {
    const e = manifest.artifacts[name];
    const obj = path.join(objects, e.encSha256);
    if (!verifiedLocal(obj, e.encSha256))
      writeFileSync(obj, await fetchVerified(e.key, e.encSha256), { mode: 0o600 });
    const link = path.join(dayDir, `${name}.${e.ext}.gz.age`);
    rmSync(link, { force: true });
    linkSync(obj, link);
  }
  writeFileSync(path.join(dayDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const required of ['d1-ebda-platform', 'd1-ebda-identity'])
    if (!names.includes(required)) throw new Error(`${latest.day}: backup set has no ${required}`);
  log(`day ${latest.day}: ${names.length} artifact(s) verified`);

  // media/: append-only mirror
  const media = await json('media/manifest.json');
  let mediaCount = 0;
  if (media) {
    for (const e of Object.values(media.objects)) {
      const file = path.join(root, e.backupKey);
      if (!path.resolve(file).startsWith(path.resolve(root) + path.sep))
        throw new Error(`unsafe media key ${e.backupKey}`);
      if (!verifiedLocal(file, e.encSha256)) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, await fetchVerified(e.backupKey, e.encSha256), { mode: 0o600 });
      }
      mediaCount++;
    }
    writeFileSync(path.join(root, 'media', 'manifest.json'), JSON.stringify(media, null, 2));
    log(`media: ${mediaCount} object(s) verified`);
  } else log('media: no media/manifest.json yet (the first nightly with ICEBERG-BK-2 has not run)');

  // retention: newest `keep` day folders; an object no day folder links to any more is removed
  const days = readdirSync(path.join(root, 'days'))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const pruned = days.slice(0, Math.max(0, days.length - keep));
  for (const d of pruned) rmSync(path.join(root, 'days', d), { recursive: true, force: true });
  let orphans = 0;
  for (const f of readdirSync(objects))
    if (statSync(path.join(objects, f)).nlink <= 1) (rmSync(path.join(objects, f)), orphans++);
  return {
    day: latest.day,
    artifacts: names.length,
    media: mediaCount,
    downloaded,
    downloadedBytes,
    pruned,
    orphans,
  };
}

/**
 * Cloudflare REST GET of one object, throttled to <= 2 requests/second (sleep after each request; the R2 API quota is 1200 per
 * 5 min, shared with the nightly job). A 429/5xx is retried at most 3 times after the server's Retry-After (capped at 300 s).
 */
export function restGet({
  accountId,
  token,
  bucket = BUCKET,
  fetchImpl = fetch,
  gapMs = 500,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
  return async key => {
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetchImpl(`${base}/${key.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
      await sleep(gapMs);
      if (!(res.status === 429 || res.status >= 500) || attempt === 3) break;
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : 2000 * attempt);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${key}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
}

/** Cloudflare REST list of every key under `prefix` (paged by cursor, throttled like restGet). */
export function restList({
  accountId,
  token,
  bucket = PRIVATE_BUCKET,
  fetchImpl = fetch,
  gapMs = 500,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
  return async prefix => {
    const keys = [];
    let cursor;
    do {
      const q = new URLSearchParams({ prefix, per_page: '1000', ...(cursor ? { cursor } : {}) });
      const res = await fetchImpl(`${base}?${q}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
      await sleep(gapMs);
      if (!res.ok) throw new Error(`LIST ${prefix}: HTTP ${res.status}`);
      const j = await res.json();
      keys.push(...(j.result ?? []).map(o => o.key));
      cursor = j.result_info?.is_truncated ? j.result_info.cursor : undefined;
    } while (cursor);
    return keys;
  };
}

/** age-encrypt FILE to the public recipient (no private key on this Mac). The default encryptor of the fiscal second copy. */
const ageFileEncryptor = recipient => (plainPath, outPath) => {
  const r = spawnSync('age', ['-r', recipient, '-o', outPath, plainPath], { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`age encrypt failed: ${r.stderr}`);
};

/**
 * Second copy of the fiscal archive (Ruling FISCAL-ARCHIVE-1), ENCRYPTED like every other file in this folder. Per store:
 * download -> sha256 against its manifest -> age-encrypt to the same PUBLIC recipient as the other CF backups -> keep ONLY
 * `fiscal-archive/v1/data/<id>.ndjson.gz.age` plus `fiscal-archive/v1/index.json` (plaintext sha from the manifest + ciphertext sha).
 * Later runs verify the ciphertext checksum; a changed .age is reported (never silently replaced). Plaintext exists only in a private
 * 0600 temp file that is removed in `finally` (error paths included). Nothing is decrypted here. A mismatch / missing object is
 * collected as `bad` (the caller raises a P1). Nothing prunes: kept for the 7-year legal retention (keep-forever).
 */
export async function pullFiscalArchive({ list, get, root, encryptFile, log = () => {} }) {
  if (!encryptFile)
    throw new Error(
      'fiscal archive: no age recipient configured, refusing to store a plaintext copy'
    );
  const base = path.join(root, 'fiscal-archive', 'v1');
  const dirM = path.join(base, 'manifests');
  const dirD = path.join(base, 'data');
  mkdirSync(dirM, { recursive: true });
  mkdirSync(dirD, { recursive: true });
  const indexFile = path.join(base, 'index.json');
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
  const bad = [];
  let stores = 0;
  let downloaded = 0;
  for (const key of await list(`${FISCAL_PREFIX}manifests/`)) {
    const name = path.basename(key);
    if (!/^[\w-]+\.json$/.test(name)) {
      bad.push(`${key}: unexpected key`);
      continue;
    }
    const mBuf = await get(key);
    if (!mBuf) {
      bad.push(`${key}: listed but missing`);
      continue;
    }
    const m = JSON.parse(mBuf.toString('utf8'));
    const id = name.slice(0, -5);
    const encFile = path.join(dirD, `${id}.ndjson.gz.age`);
    const have = index[id];
    if (have && have.plainSha256 === m.sha256 && existsSync(encFile)) {
      if (sha256(readFileSync(encFile)) !== have.encSha256) {
        bad.push(
          `${id}: local .age differs from its recorded ciphertext checksum (tampered or corrupt)`
        );
        continue;
      }
      writeFileSync(path.join(dirM, name), mBuf, { mode: 0o600 });
      stores++;
      continue;
    }
    const d = await get(`${FISCAL_PREFIX}data/${id}.ndjson.gz`);
    if (!d) {
      bad.push(`${id}: data object missing in R2`);
      continue;
    }
    if (sha256(d) !== m.sha256) {
      bad.push(`${id}: data sha256 differs from its manifest`);
      continue;
    }
    const tmp = mkdtempSync(path.join(tmpdir(), 'fa-plain-'));
    try {
      const plain = path.join(tmp, 'plain');
      writeFileSync(plain, d, { mode: 0o600 });
      const out = path.join(tmp, 'out.age');
      encryptFile(plain, out);
      const enc = readFileSync(out);
      writeFileSync(encFile, enc, { mode: 0o600 });
      index[id] = {
        plainSha256: m.sha256,
        encSha256: sha256(enc),
        file: `data/${id}.ndjson.gz.age`,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    writeFileSync(path.join(dirM, name), mBuf, { mode: 0o600 });
    downloaded++;
    stores++;
  }
  writeFileSync(indexFile, JSON.stringify(index, null, 2), { mode: 0o600 });
  log(
    `fiscal-archive: ${stores} store archive(s) verified, ${downloaded} downloaded, ${bad.length} bad`
  );
  return { stores, downloaded, bad };
}

const keychain = service => {
  const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : '';
};

async function main() {
  const stamp = m => console.log(`${new Date().toISOString()} pull-cf-backups: ${m}`);
  const alert = async text => {
    const bot = process.env.TELEGRAM_BOT_TOKEN || keychain('ebda-alert-telegram-bot');
    const chat = process.env.TELEGRAM_ALERT_CHAT_ID || keychain('ebda-alert-telegram-chat');
    if (bot && chat) {
      const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text }),
      }).catch(e => ({ ok: false, status: String(e) }));
      stamp(`telegram alert ${r.ok ? 'sent' : `NOT sent (${r.status})`}`);
    } else
      stamp('telegram alert NOT sent: no TELEGRAM_* env or ebda-alert-telegram-* Keychain items');
    spawnSync('osascript', [
      '-e',
      `display notification ${JSON.stringify(text.slice(0, 200))} with title "Ebda backup pull"`,
    ]);
  };
  const token = process.env.EBDA_R2_READ_TOKEN || keychain('ebda-r2-backup-read');
  if (!token) {
    stamp(
      'FATAL: no EBDA_R2_READ_TOKEN and no Keychain item ebda-r2-backup-read; NOTHING was pulled'
    );
    await alert(
      'Ebda off-account backup pull did NOT run: the R2 read token is missing (Keychain item ebda-r2-backup-read).'
    );
    process.exit(2);
  }
  const root =
    process.env.EBDA_CF_BACKUP_PULL_ROOT ||
    path.join(homedir(), 'Desktop/projects/_backups/ebda-cf-encrypted');
  try {
    stamp(`start -> ${root}`);
    const r = await pullBackups({
      get: restGet({ accountId: process.env.EBDA_CF_ACCOUNT_ID || DEFAULT_ACCOUNT_ID, token }),
      root,
      keep: Number(process.env.EBDA_CF_BACKUP_PULL_KEEP) || 30,
      log: stamp,
    });
    const acct = process.env.EBDA_CF_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
    const recipient = process.env.EBDA_BACKUP_AGE_PUBLIC_KEY || keychain('ebda-backup-age-public');
    const fa = await pullFiscalArchive({
      list: restList({ accountId: acct, token }),
      get: restGet({ accountId: acct, token, bucket: PRIVATE_BUCKET }),
      root,
      encryptFile: recipient ? ageFileEncryptor(recipient) : undefined,
      log: stamp,
    });
    if (fa.bad.length) {
      stamp(`P1 fiscal archive integrity: ${fa.bad.join('; ')}`);
      await alert(
        `P1 Ebda fiscal archive second copy: ${fa.bad.length} problem(s): ${fa.bad.slice(0, 3).join('; ')}`
      );
      process.exit(1);
    }
    stamp(
      `done - day ${r.day}, ${r.artifacts} artifacts + ${r.media} media verified, ${r.downloaded} downloaded (${(r.downloadedBytes / 1048576).toFixed(2)} MiB), ${r.pruned.length} day(s) pruned, ${r.orphans} orphan object(s) removed`
    );
  } catch (e) {
    stamp(`ERROR: ${e?.message ?? e}`);
    await alert(`Ebda off-account backup pull FAILED: ${e?.message ?? e}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
