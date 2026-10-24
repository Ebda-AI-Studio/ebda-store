// Pure helpers for scripts/upsert-super-admin.mjs (no node-only imports, so the tests run them inside workerd too).
// Every value that reaches SQL is validated against a strict pattern first: the SQL is built as text because it is written
// to a temp file for `wrangler d1 execute --file`, so nothing here may ever carry a quote or a statement separator.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const NAME_RE = /^[\p{L}\p{M} .'-]{1,60}$/u;

/** Flags: --email=<e> (required) --first-name= --last-name= --apply. A password is NEVER accepted as an argument. */
export function parseArgs(argv) {
  const out = { apply: false, email: null, firstName: 'Platform', lastName: 'Admin' };
  for (const a of argv) {
    if (/^--(password|pass|pwd)\b/i.test(a)) {
      throw new Error(
        'Refusing: a password must never be passed as an argument (shell history, process list, agents). Run with --apply and type it when prompted.'
      );
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unknown argument: ${a}`);
    const [, k, v] = m;
    if (k === 'apply') out.apply = true;
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
  return out;
}

/** The same bar the service applies to a merchant, raised to 14 for a platform administrator. */
export function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 14) return 'at least 14 characters';
  if (p.length > 128) return 'at most 128 characters';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p))
    return 'a lower-case letter, an upper-case letter, a digit and a symbol';
  return null;
}

export const lookupSql = email => {
  if (!EMAIL_RE.test(email)) throw new Error('bad email');
  return `SELECT id, role, status, email_verified, mfa_enabled, (SELECT count(*) FROM passkey_credentials p WHERE p.user_id = users.id) AS passkeys FROM users WHERE lower(email) = '${email.toLowerCase()}' AND deleted_at IS NULL`;
};

/** Human-readable plan for the dry run. */
export function describePlan(existing, email) {
  if (!existing)
    return [
      `No identity for ${email}.`,
      'Plan: CREATE a super_admin (verified, active) with the password you type.',
    ];
  return [
    `Existing identity ${existing.id}: role ${existing.role}, status ${existing.status}, TOTP ${existing.mfa_enabled ? 'on' : 'off'}, passkeys ${existing.passkeys}.`,
    'Plan: PROMOTE to super_admin, set the password you type, mark the e-mail verified and the account active, end every session.',
    existing.mfa_enabled || existing.passkeys > 0
      ? 'Second factor: already enrolled, kept.'
      : 'Second factor: NONE yet. Sign-in works but carries no admin power until you enrol TOTP or a passkey (the sign-in response says so).',
  ];
}

/** The statements to run, in one batch. Idempotent: running it again changes nothing but the password hash and the session cut-off. */
export function buildUpsertSql({
  existingId,
  newId,
  email,
  passwordHash,
  firstName,
  lastName,
  nowIso,
  nowMs,
}) {
  if (!EMAIL_RE.test(email)) throw new Error('bad email');
  if (!BCRYPT_RE.test(passwordHash)) throw new Error('bad password hash');
  if (!NAME_RE.test(firstName) || !NAME_RE.test(lastName)) throw new Error('bad name');
  if (existingId !== null && !UUID_RE.test(existingId)) throw new Error('bad id');
  if (existingId === null && !UUID_RE.test(newId)) throw new Error('bad new id');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(nowIso) || !Number.isInteger(nowMs))
    throw new Error('bad time');
  const e = email.toLowerCase();
  if (existingId) {
    return [
      `UPDATE users SET role = 'super_admin', password_hash = '${passwordHash}', status = 'active', email_verified = 1, deleted_at = NULL, token_version = token_version + 1, updated_at = '${nowIso}' WHERE id = '${existingId}'`,
      `UPDATE sessions SET revoked_at = ${nowMs}, revoked_reason = 'super-admin-upsert' WHERE user_id = '${existingId}' AND revoked_at IS NULL`,
      `UPDATE refresh_tokens SET revoked_at = '${nowIso}', revoked_reason = COALESCE(revoked_reason, 'super-admin-upsert') WHERE user_id = '${existingId}' AND revoked_at IS NULL`,
    ];
  }
  return [
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, email_verified, language, created_at, updated_at) VALUES ('${newId}', '${e}', '${passwordHash}', '${firstName.replaceAll("'", "''")}', '${lastName.replaceAll("'", "''")}', 'super_admin', 'active', 1, 'en', '${nowIso}', '${nowIso}')`,
  ];
}
