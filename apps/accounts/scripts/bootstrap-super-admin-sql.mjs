// Pure helpers for scripts/bootstrap-super-admin.mjs (no node-only imports, so the tests run them inside workerd too).
// Ruling ID-20. Every value that reaches SQL is validated against a strict pattern first: the SQL is built as text because it is
// written to a temp file for `wrangler d1 execute --file`, so nothing here may ever carry a quote or a statement separator.
// NOTHING here creates, reads or carries a password, a password hash or a code: the account is created with the unusable
// marker '!pending' and the owner sets the password through the service's own reset flow (a code mailed to the address).
import { ENROLMENT_TOKEN_TTL_MS } from './super-admin-sql.mjs';

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[\p{L}\p{M} .'-]{1,60}$/u;
const ACTOR_RE = /^[A-Za-z0-9._%+@-]{1,120}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The marker the service already uses for an account with no credential yet (registerPending / inviteFor). */
export const NO_PASSWORD = '!pending';

/**
 * Flags: --email=<e> (required) --first-name= --last-name= --allow-additional --resend-email --issue-enrolment-token
 * --apply --remote|--local. A password (or anything password-shaped) is NEVER accepted as an argument.
 */
export function parseBootstrapArgs(argv) {
  const out = {
    apply: false,
    allowAdditional: false,
    resendEmail: false,
    issueEnrolmentToken: false,
    email: null,
    firstName: 'Platform',
    lastName: 'Admin',
    remote: false,
    local: false,
  };
  for (const a of argv) {
    if (/^--(password|pass|pwd|hash|code|token)\b(?!-)/i.test(a))
      throw new Error('Refusing: no password, hash, code or token is ever passed as an argument.');
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unknown argument: ${a}`);
    const [, k, v] = m;
    if (k === 'apply') out.apply = true;
    else if (k === 'allow-additional') out.allowAdditional = true;
    else if (k === 'resend-email') out.resendEmail = true;
    else if (k === 'issue-enrolment-token') out.issueEnrolmentToken = true;
    else if (k === 'email') out.email = v ?? '';
    else if (k === 'first-name') out.firstName = v ?? '';
    else if (k === 'last-name') out.lastName = v ?? '';
    else if (k === 'remote' || k === 'local') out[k] = true;
    else throw new Error(`Unknown flag: --${k}`);
  }
  if (!out.email || !EMAIL_RE.test(out.email)) throw new Error('Required: --email=<valid address>');
  out.email = out.email.toLowerCase();
  if (!NAME_RE.test(out.firstName) || !NAME_RE.test(out.lastName))
    throw new Error('Invalid --first-name / --last-name');
  if (out.remote === out.local) throw new Error('Required: exactly one of --remote / --local');
  if (out.issueEnrolmentToken && out.resendEmail)
    throw new Error('--issue-enrolment-token and --resend-email are separate steps');
  return out;
}

/** The target account (no credential columns) plus the number of OTHER active platform admins. */
export const stateSql = email => {
  if (!EMAIL_RE.test(email)) throw new Error('bad email');
  const e = email.toLowerCase();
  return `SELECT
  (SELECT count(*) FROM users WHERE role = 'super_admin' AND status = 'active' AND deleted_at IS NULL AND lower(email) <> '${e}') AS other_admins,
  u.id, u.role, u.status, u.email_verified, u.mfa_enabled,
  (u.password_hash = '${NO_PASSWORD}') AS no_password,
  (SELECT count(*) FROM passkey_credentials p WHERE p.user_id = u.id) AS passkeys
FROM (SELECT 1) LEFT JOIN users u ON lower(u.email) = '${e}' AND u.deleted_at IS NULL`;
};

/** A row of stateSql -> { otherAdmins, target|null }. */
export function readState(row) {
  const otherAdmins = Number(row?.other_admins ?? 0);
  if (!row || !row.id) return { otherAdmins, target: null };
  return {
    otherAdmins,
    target: {
      id: row.id,
      role: row.role,
      status: row.status,
      emailVerified: !!row.email_verified,
      noPassword: !!row.no_password,
      hasFactor: !!row.mfa_enabled || Number(row.passkeys) > 0,
    },
  };
}

/**
 * What to do. Pure, so every branch is tested.
 *  create        no identity for the address, and either no other active admin or --allow-additional.
 *  refuse        an identity with another role exists (promotion clears factors: that is upsert-super-admin.mjs's job), or
 *                another active admin exists and --allow-additional was not given, or the account is not active.
 *  noop          already a super_admin (idempotent re-run). With --resend-email and still no password: `resend`.
 *  issue-token   --issue-enrolment-token on a super_admin who has set a password (verified) and has no factor yet.
 */
export function planBootstrap(state, args) {
  const { target, otherAdmins } = state;
  if (args.issueEnrolmentToken) {
    if (!target || target.role !== 'super_admin')
      return { action: 'refuse', reason: 'no super_admin with this address' };
    if (target.status !== 'active')
      return { action: 'refuse', reason: `account is ${target.status}` };
    if (!target.emailVerified || target.noPassword)
      return {
        action: 'refuse',
        reason: 'the password is not set yet: open the e-mailed code and set it first',
      };
    if (target.hasFactor)
      return {
        action: 'refuse',
        reason: 'a second factor is already enrolled; no token is needed',
      };
    return { action: 'issue-token' };
  }
  if (target) {
    if (target.role !== 'super_admin')
      return {
        action: 'refuse',
        reason: `an identity with role ${target.role} already uses this address; promoting it is upsert-super-admin.mjs's job (it clears old factors)`,
      };
    if (target.status !== 'active')
      return { action: 'refuse', reason: `account is ${target.status}` };
    if (args.resendEmail && target.noPassword && !target.emailVerified) return { action: 'resend' };
    return { action: 'noop' };
  }
  if (otherAdmins > 0 && !args.allowAdditional)
    return {
      action: 'refuse',
      reason: `${otherAdmins} active super_admin(s) already exist; pass --allow-additional to add another`,
    };
  return { action: 'create' };
}

function checkCommon({ userId, email, actor, nowMs }) {
  if (!UUID_RE.test(userId)) throw new Error('bad id');
  if (!EMAIL_RE.test(email)) throw new Error('bad email');
  if (!ACTOR_RE.test(actor)) throw new Error('bad actor');
  if (!Number.isInteger(nowMs)) throw new Error('bad time');
}

/** The audit row is written only if the account it names exists (a guarded insert that lost a race writes no audit row). */
const auditSql = (event, { userId, email, actor, nowMs, detail }) =>
  `INSERT INTO admin_audit (event, user_id, email, actor, at, detail) SELECT '${event}', '${userId}', '${email.toLowerCase()}', '${actor}', ${nowMs}, '${JSON.stringify(detail ?? {}).replaceAll("'", "''")}' WHERE EXISTS (SELECT 1 FROM users WHERE id = '${userId}' AND role = 'super_admin')`;

/**
 * CREATE: an active super_admin with NO usable password and an UNVERIFIED address, plus its audit row, in one batch. The
 * INSERT is guarded so a concurrent run (or an address taken in between) inserts nothing; the caller re-reads to verify.
 */
export function buildBootstrapSql({
  userId,
  email,
  firstName,
  lastName,
  actor,
  nowMs,
  allowAdditional,
}) {
  checkCommon({ userId, email, actor, nowMs });
  if (!NAME_RE.test(firstName) || !NAME_RE.test(lastName)) throw new Error('bad name');
  const e = email.toLowerCase();
  const nowIso = new Date(nowMs).toISOString();
  const q = s => s.replaceAll("'", "''");
  return [
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, email_verified, language, created_at, updated_at)
SELECT '${userId}', '${e}', '${NO_PASSWORD}', '${q(firstName)}', '${q(lastName)}', 'super_admin', 'active', 0, 'en', '${nowIso}', '${nowIso}'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = '${e}')`,
    auditSql('super_admin_bootstrapped', {
      userId,
      email: e,
      actor,
      nowMs,
      detail: { allowAdditional: !!allowAdditional },
    }),
  ];
}

/** ISSUE-TOKEN: replaces any earlier token of this account (single live token), stores only the sha256, audits it. */
export function buildIssueTokenSql({ userId, email, actor, nowMs, tokenId, tokenHash }) {
  checkCommon({ userId, email, actor, nowMs });
  if (!UUID_RE.test(tokenId) || !SHA256_RE.test(tokenHash)) throw new Error('bad token');
  return [
    `DELETE FROM enrolment_tokens WHERE user_id = '${userId}'`,
    `INSERT INTO enrolment_tokens (id, user_id, token_hash, expires_at, created_at) VALUES ('${tokenId}', '${userId}', '${tokenHash}', ${nowMs + ENROLMENT_TOKEN_TTL_MS}, ${nowMs})`,
    auditSql('super_admin_enrolment_token_issued', { userId, email, actor, nowMs, detail: {} }),
  ];
}

/** Read-only proof that the service queued the set-password code (count + flag only; never the code column). */
export const resetIssuedSql = (userId, sinceIso) => {
  if (!UUID_RE.test(userId) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(sinceIso))
    throw new Error('bad input');
  return `SELECT count(*) AS n FROM verification_tokens WHERE user_id = '${userId}' AND type = 'password_reset' AND sent = 1 AND created_at >= '${sinceIso}'`;
};

/** Sanitise the operator name for the audit row. */
export function actorName(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._%+@-]/g, '')
    .slice(0, 120);
  return s || 'unknown';
}
