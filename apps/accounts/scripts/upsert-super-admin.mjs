#!/usr/bin/env node
// Create or promote a platform administrator (super_admin) in the shared identity service (D1 ebda-identity).
// Successor of scripts/admin-upsert-super-admin.mjs, which wrote to the Store's Postgres and stops being the source of truth
// once accounts.ebda.app is live (Rulings ID-1/ID-2/ID-15).
//
//   node scripts/upsert-super-admin.mjs --email=you@example.com --remote            # dry run: shows the plan, writes nothing
//   node scripts/upsert-super-admin.mjs --email=you@example.com --remote --apply     # asks for the password (hidden, twice), writes
//   add --reset-factors to wipe the account's TOTP/passkeys even if it already is a super_admin
// The first TOTP/passkey of a super_admin can only be enrolled with the one-time token this script prints PLUS a code e-mailed
// to the account (a leaked or phished password alone cannot bind a factor). Promoting an existing account clears its old factors.
//
// YOU run this yourself, in your own terminal. The password is typed at a hidden prompt and never accepted as an argument
// (the script refuses --password). It is hashed here (bcrypt cost 12); only the hash is written, through a 0600 temp file
// that is deleted afterwards. Idempotent: the same command again just re-sets the password and ends the sessions.
// Needs: wrangler logged in to the Cloudflare account that owns ebda-identity (CLOUDFLARE_ACCOUNT_ID=69188202efc4df480140dd76545aa3ab).
// A super_admin has NO admin power until they sign in with a second factor: enrol TOTP or a passkey at the first sign-in.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  buildUpsertSql,
  decide,
  describePlan,
  lookupSql,
  parseArgs,
  passwordProblem,
} from './super-admin-sql.mjs';

const DB = 'ebda-identity';

function wrangler(args, input) {
  const r = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', input });
  if (r.status !== 0)
    throw new Error(`wrangler ${args[0]} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const write = rl._writeToOutput;
    rl._writeToOutput = s => (s.includes(question) ? write.call(rl, s) : undefined); // hide the typed characters
    rl.question(question, a => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const target = args.local ? '--local' : '--remote';

const rows = JSON.parse(
  wrangler(['d1', 'execute', DB, target, '--json', '--command', lookupSql(args.email)])
);
const existing = rows?.[0]?.results?.[0] ?? null;
for (const line of describePlan(existing, args.email, args.resetFactors)) console.log(line);

if (!args.apply) {
  console.log(
    '\nDRY RUN. Nothing was written. Re-run with --apply to continue (you will type the password).'
  );
  process.exit(0);
}
if (!process.stdin.isTTY) {
  console.error(
    'Refusing: --apply needs an interactive terminal so the password is typed by you, never piped.'
  );
  process.exit(1);
}

const p1 = await ask('New password (hidden): ');
const problem = passwordProblem(p1);
if (problem) {
  console.error(`Password rejected: needs ${problem}.`);
  process.exit(1);
}
if (p1 !== (await ask('Repeat password: '))) {
  console.error('The two entries differ.');
  process.exit(1);
}

const now = new Date();
const plan = decide(existing, args.resetFactors);
const enrolmentToken = plan.issueToken ? randomBytes(32).toString('base64url') : null;
const statements = buildUpsertSql({
  existingId: existing?.id ?? null,
  newId: crypto.randomUUID(),
  email: args.email,
  passwordHash: await bcrypt.hash(p1, 12),
  firstName: args.firstName,
  lastName: args.lastName,
  nowIso: now.toISOString(),
  nowMs: now.getTime(),
  clearFactors: plan.clearFactors,
  tokenHash: enrolmentToken ? createHash('sha256').update(enrolmentToken).digest('hex') : null,
  tokenId: enrolmentToken ? crypto.randomUUID() : null,
});
const dir = mkdtempSync(join(tmpdir(), 'super-admin-'));
const file = join(dir, 'upsert.sql');
try {
  writeFileSync(file, statements.join(';\n') + ';\n', { mode: 0o600 });
  wrangler(['d1', 'execute', DB, target, '--file', file]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const check = JSON.parse(
  wrangler(['d1', 'execute', DB, target, '--json', '--command', lookupSql(args.email)])
);
const row = check?.[0]?.results?.[0];
if (!row || row.role !== 'super_admin') {
  console.error('Write did not verify: the identity is not a super_admin.');
  process.exit(1);
}
console.log(`Done: ${args.email} is a super_admin (${row.id}).`);
if (enrolmentToken) {
  console.log(
    '\nONE-TIME ENROLMENT TOKEN (shown once, valid 30 minutes, single use, stored only as a hash):'
  );
  console.log(`  ${enrolmentToken}`);
  console.log(
    'Sign in at the admin app, open Account > Security, request the e-mailed code, then enrol TOTP or a passkey with this token and that code.'
  );
}
