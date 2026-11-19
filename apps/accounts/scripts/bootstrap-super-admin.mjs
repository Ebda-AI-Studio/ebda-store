#!/usr/bin/env node
// Bootstrap a platform administrator (super_admin) in the shared identity service (D1 ebda-identity) WITHOUT any password
// passing through the operator, the shell or an agent (Ruling ID-20, alongside ID-15).
//
//   node scripts/bootstrap-super-admin.mjs --email=you@ebda.app --remote                 # dry run: shows the plan, writes nothing
//   node scripts/bootstrap-super-admin.mjs --email=you@ebda.app --remote --apply         # creates it + mails the set-password code
//   node scripts/bootstrap-super-admin.mjs --email=you@ebda.app --remote --apply --resend-email
//   node scripts/bootstrap-super-admin.mjs --email=you@ebda.app --remote --apply --issue-enrolment-token   # OWNER ONLY, own terminal
//   node scripts/bootstrap-super-admin.mjs --email=you@ebda.app --remote --show-audit    # read-only: the audit rows for the address
//
// CREATE writes, in one batch: an active super_admin with NO usable password ('!pending') and an UNVERIFIED address, plus an
// `admin_audit` row. Then it asks the service itself (POST /password/forgot) to mail the set-password code, and verifies from
// D1 that a code was queued (count only; the code column is never read). Setting the password with that code verifies the
// address (POST /password/reset). It refuses when another active super_admin exists unless --allow-additional, refuses an
// address that already belongs to another role (promotion is upsert-super-admin.mjs's job: it clears planted factors), and is
// a no-op when re-run for an existing super_admin.
//
// The admin has NO admin power until a second factor is enrolled (the identity service mints `pa: super_admin` only for a
// session created with TOTP or a passkey; the Store grants super_admin only from `pa`). The FIRST factor needs the one-time
// enrolment token (Ruling ID-15) + a code e-mailed to the account. --issue-enrolment-token prints that token, so it runs only
// with an interactive terminal on stdin AND stdout (a piped or captured run is refused): the owner runs it himself, right
// before enrolling (30 minutes, single use, stored only as a sha256).
// Needs: wrangler logged in to the Cloudflare account that owns ebda-identity (CLOUDFLARE_ACCOUNT_ID=69188202efc4df480140dd76545aa3ab).
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  actorName,
  buildBootstrapSql,
  buildIssueTokenSql,
  parseBootstrapArgs,
  planBootstrap,
  readState,
  resetIssuedSql,
  stateSql,
} from './bootstrap-super-admin-sql.mjs';

const DB = 'ebda-identity';
const ACCOUNTS_ORIGIN = process.env.ACCOUNTS_ORIGIN || 'https://accounts.ebda.app';

function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(`wrangler ${args[0]} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}
const query = (target, sql) =>
  JSON.parse(wrangler(['d1', 'execute', DB, target, '--json', '--command', sql]))?.[0]?.results ??
  [];

function runFile(target, statements) {
  const dir = mkdtempSync(join(tmpdir(), 'super-admin-'));
  const file = join(dir, 'bootstrap.sql');
  try {
    writeFileSync(file, statements.join(';\n') + ';\n', { mode: 0o600 });
    wrangler(['d1', 'execute', DB, target, '--file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function operator() {
  try {
    const e = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
    if (e) return actorName(e);
  } catch {
    /* no git identity: fall back to the OS user */
  }
  return actorName(userInfo().username);
}

/** The service mails the code itself (same path as "Forgot your password?"); the answer is deliberately generic. */
async function requestSetPasswordMail(email) {
  const res = await fetch(`${ACCOUNTS_ORIGIN}/password/forgot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.status !== 202) throw new Error(`POST /password/forgot answered ${res.status}`);
}

async function mailAndVerify(target, args, userId) {
  if (args.local) {
    console.log(
      '--local: no set-password e-mail is requested (the local service is not reachable from here).'
    );
    return;
  }
  const since = new Date(Date.now() - 5_000).toISOString();
  await requestSetPasswordMail(args.email);
  // The service queues the mail after answering; give it a moment, then prove a code was issued and marked sent.
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    if (Number(query(target, resetIssuedSql(userId, since))[0]?.n ?? 0) > 0) {
      console.log(
        `Set-password code issued and sent to ${args.email} (valid per the service's reset TTL).`
      );
      return;
    }
  }
  throw new Error(
    'No set-password code was recorded within 15 s (rate limit, or the account is not active). Re-run with --resend-email later.'
  );
}

const args = parseBootstrapArgs(process.argv.slice(2).filter(a => a !== '--show-audit'));
const target = args.local ? '--local' : '--remote';

if (process.argv.includes('--show-audit')) {
  const rows = query(
    target,
    `SELECT event, user_id, actor, datetime(at/1000,'unixepoch') AS at_utc, detail FROM admin_audit WHERE email = '${args.email}' ORDER BY at`
  );
  console.table(rows);
  process.exit(0);
}

const tables = query(
  target,
  `SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit'`
);
if (tables.length === 0) {
  console.error(
    'Refusing: table admin_audit is missing (apply migration 0006 first: the accounts deploy does it).'
  );
  process.exit(1);
}

const state = readState(query(target, stateSql(args.email))[0]);
const plan = planBootstrap(state, args);
console.log(
  state.target
    ? `Identity ${state.target.id}: role ${state.target.role}, status ${state.target.status}, verified ${state.target.emailVerified}, password set ${!state.target.noPassword}, second factor ${state.target.hasFactor}.`
    : `No identity for ${args.email}.`
);
console.log(
  `Other active super_admins: ${state.otherAdmins}. Plan: ${plan.action}${plan.reason ? ` (${plan.reason})` : ''}.`
);

if (plan.action === 'refuse') process.exit(1);
if (plan.action === 'noop') {
  console.log(
    'Nothing to do (idempotent re-run). Use --resend-email if the set-password code was lost.'
  );
  process.exit(0);
}
if (!args.apply) {
  console.log('\nDRY RUN. Nothing was written. Re-run with --apply.');
  process.exit(0);
}

const actor = operator();
const nowMs = Date.now();

if (plan.action === 'create') {
  const userId = crypto.randomUUID();
  runFile(
    target,
    buildBootstrapSql({
      userId,
      email: args.email,
      firstName: args.firstName,
      lastName: args.lastName,
      actor,
      nowMs,
      allowAdditional: args.allowAdditional,
    })
  );
  const after = readState(query(target, stateSql(args.email))[0]).target;
  if (
    !after ||
    after.id !== userId ||
    after.role !== 'super_admin' ||
    !after.noPassword ||
    after.emailVerified
  ) {
    console.error(
      'Write did not verify: the identity is not the password-less, unverified super_admin just created.'
    );
    process.exit(1);
  }
  console.log(
    `Created: ${args.email} is a super_admin (${userId}), no password, address unverified. Audit row written (actor ${actor}).`
  );
  await mailAndVerify(target, args, userId);
} else if (plan.action === 'resend') {
  await mailAndVerify(target, args, state.target.id);
} else if (plan.action === 'issue-token') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'Refusing: the enrolment token is printed once, so this runs only in your own interactive terminal (stdin and stdout).'
    );
    process.exit(1);
  }
  const token = randomBytes(32).toString('base64url');
  runFile(
    target,
    buildIssueTokenSql({
      userId: state.target.id,
      email: args.email,
      actor,
      nowMs,
      tokenId: crypto.randomUUID(),
      tokenHash: createHash('sha256').update(token).digest('hex'),
    })
  );
  console.log(
    '\nONE-TIME ENROLMENT TOKEN (shown once, valid 30 minutes, single use, stored only as a hash):'
  );
  console.log(`  ${token}`);
  console.log(
    'Sign in at store.ebda.app, open Account > Security, request the e-mailed code, then enrol TOTP or a passkey with this token and that code.'
  );
}
