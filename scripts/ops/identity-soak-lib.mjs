// Identity stage 5 soak gate: the pure part (no I/O), so it is unit-tested. The CLI is identity-soak-gate.mjs.
// A criterion that could not be measured is NOT a pass: unknown fails the gate.

export const CRITERIA = {
  noHs256AdminLogins: 'zero HS256 admin logins in the soak window',
  superAdminSecondFactor: 'every active super-admin has a second factor enrolled',
  adminSignInViaAccountsOnly: 'admin and orders sign in through accounts only',
  noLegacyAdminRefresh: 'no live legacy admin refresh tokens',
};

// Store endpoints the admin and orders apps must no longer call (sign-in and session issue). Comments are stripped first.
const LEGACY_ENDPOINT =
  /['"`]\/?auth\/(login|refresh|mfa(?:\/[a-z-]+)?|passkey(?:\/[a-z-]+)*|register|forgot-password|reset-password)['"`/?]/;

export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** files: [{ path, text }] from apps/admin/src and apps/orders/src (tests excluded by the caller). */
export function scanLegacySignIn(files) {
  const hits = [];
  for (const f of files) {
    const lines = stripComments(f.text).split('\n');
    lines.forEach((line, i) => {
      if (LEGACY_ENDPOINT.test(line)) hits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return hits;
}

const unknown = v => v === undefined || v === null || Number.isNaN(v);

/**
 * input: {
 *   windowDays, minWindowDays,
 *   hs256AdminLogins: number|undefined      (refresh_tokens issued to admin-namespace users since the window start)
 *   superAdmins: [{ email, mfaEnabled, passkeys }]|undefined
 *   legacySignInRefs: string[]|undefined    (scanLegacySignIn output)
 *   liveLegacyRefresh: number|undefined     (unrevoked, unexpired refresh_tokens of admin-namespace users)
 * }
 */
export function evaluateSoak(input) {
  const c = [];
  const add = (id, pass, detail) => c.push({ id, name: CRITERIA[id], pass, detail });

  if (!(input.windowDays >= input.minWindowDays))
    add(
      'noHs256AdminLogins',
      false,
      `window is ${input.windowDays} days, need at least ${input.minWindowDays}`
    );
  else if (unknown(input.hs256AdminLogins))
    add('noHs256AdminLogins', false, 'NOT MEASURED (no read-only Store database URL)');
  else
    add(
      'noHs256AdminLogins',
      input.hs256AdminLogins === 0,
      `${input.hs256AdminLogins} legacy admin sessions issued in ${input.windowDays} days`
    );

  if (!Array.isArray(input.superAdmins))
    add('superAdminSecondFactor', false, 'NOT MEASURED (identity D1 unreachable)');
  else if (input.superAdmins.length === 0)
    add('superAdminSecondFactor', false, 'no active super-admin exists');
  else {
    const bad = input.superAdmins.filter(s => !(s.mfaEnabled || s.passkeys > 0));
    add(
      'superAdminSecondFactor',
      bad.length === 0,
      bad.length
        ? `${bad.length} of ${input.superAdmins.length} super-admin(s) have no second factor`
        : `${input.superAdmins.length} super-admin(s), all enrolled`
    );
  }

  if (!Array.isArray(input.legacySignInRefs))
    add('adminSignInViaAccountsOnly', false, 'NOT MEASURED (sources not scanned)');
  else
    add(
      'adminSignInViaAccountsOnly',
      input.legacySignInRefs.length === 0,
      input.legacySignInRefs.length
        ? input.legacySignInRefs.slice(0, 5).join(' | ')
        : 'no Store sign-in endpoint is called by apps/admin or apps/orders'
    );

  if (unknown(input.liveLegacyRefresh))
    add('noLegacyAdminRefresh', false, 'NOT MEASURED (no read-only Store database URL)');
  else
    add(
      'noLegacyAdminRefresh',
      input.liveLegacyRefresh === 0,
      `${input.liveLegacyRefresh} live legacy admin refresh token(s)`
    );

  return { pass: c.every(x => x.pass), criteria: c };
}
