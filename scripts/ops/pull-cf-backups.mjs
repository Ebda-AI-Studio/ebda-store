#!/usr/bin/env node
// OFF-ACCOUNT copy of the nightly backup (Ruling ICEBERG-BK-3). cf-backup.yml writes D1 ebda-platform + ebda-identity + every
// StoreDO (age-encrypted) and the R2 ebda-media copy into R2 `ebda-db-backups`, which lives in the SAME Cloudflare account as
// production. This job pulls them to this Mac over the Cloudflare REST API (api.cloudflare.com; workers.dev is ISP-blocked), so
// losing the Cloudflare account does not lose the data. House pattern: backup-all-neon.sh (launchd, local, keeps 30).
//
//   ROOT/objects/<encSha256>                      every encrypted artifact once (content-addressed; reused artifacts cost nothing)
//   ROOT/days/<YYYY-MM-DD>/<name>.<ext>.gz.age    hard links into objects/ + manifest.json; the newest KEEP (30) days are kept
//   ROOT/media/<backupKey> + media/manifest.json  append-only mirror of media/ (never pruned: an image deleted in production stays)
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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ACCOUNT_ID = '69188202efc4df480140dd76545aa3ab';
export const BUCKET = 'ebda-db-backups';
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
  const age = Math.floor((Date.parse(now.toISOString().slice(0, 10)) - Date.parse(latest.day)) / DAY_MS);
  if (age > MAX_AGE_DAYS) throw new Error(`newest backup is ${latest.day}, ${age} days old (limit ${MAX_AGE_DAYS})`);
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
    if (!verifiedLocal(obj, e.encSha256)) writeFileSync(obj, await fetchVerified(e.key, e.encSha256), { mode: 0o600 });
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
      if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) throw new Error(`unsafe media key ${e.backupKey}`);
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
  const days = readdirSync(path.join(root, 'days')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const pruned = days.slice(0, Math.max(0, days.length - keep));
  for (const d of pruned) rmSync(path.join(root, 'days', d), { recursive: true, force: true });
  let orphans = 0;
  for (const f of readdirSync(objects))
    if (statSync(path.join(objects, f)).nlink <= 1) (rmSync(path.join(objects, f)), orphans++);
  return { day: latest.day, artifacts: names.length, media: mediaCount, downloaded, downloadedBytes, pruned, orphans };
}

/**
 * Cloudflare REST GET of one object, throttled to <= 2 requests/second (sleep after each request; the R2 API quota is 1200 per
 * 5 min, shared with the nightly job). A 429/5xx is retried at most 3 times after the server's Retry-After (capped at 300 s).
 */
export function restGet({ accountId, token, fetchImpl = fetch, gapMs = 500, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}/objects`;
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

const keychain = service => {
  const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8' });
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
    } else stamp('telegram alert NOT sent: no TELEGRAM_* env or ebda-alert-telegram-* Keychain items');
    spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text.slice(0, 200))} with title "Ebda backup pull"`]);
  };
  const token = process.env.EBDA_R2_READ_TOKEN || keychain('ebda-r2-backup-read');
  if (!token) {
    stamp('FATAL: no EBDA_R2_READ_TOKEN and no Keychain item ebda-r2-backup-read; NOTHING was pulled');
    await alert('Ebda off-account backup pull did NOT run: the R2 read token is missing (Keychain item ebda-r2-backup-read).');
    process.exit(2);
  }
  const root = process.env.EBDA_CF_BACKUP_PULL_ROOT || path.join(homedir(), 'Desktop/projects/_backups/ebda-cf-encrypted');
  try {
    stamp(`start -> ${root}`);
    const r = await pullBackups({
      get: restGet({ accountId: process.env.EBDA_CF_ACCOUNT_ID || DEFAULT_ACCOUNT_ID, token }),
      root,
      keep: Number(process.env.EBDA_CF_BACKUP_PULL_KEEP) || 30,
      log: stamp,
    });
    stamp(
      `done - day ${r.day}, ${r.artifacts} artifacts + ${r.media} media verified, ${r.downloaded} downloaded (${(r.downloadedBytes / 1048576).toFixed(2)} MiB), ${r.pruned.length} day(s) pruned, ${r.orphans} orphan object(s) removed`
    );
  } catch (e) {
    stamp(`ERROR: ${e?.message ?? e}`);
    await alert(`Ebda off-account backup pull FAILED: ${e?.message ?? e}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
