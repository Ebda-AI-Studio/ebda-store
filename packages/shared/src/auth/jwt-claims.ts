/**
 * JWT `iss` / `aud` claim values: the ONE place they are defined.
 *
 * Mint with the Ebda values (`JWT_*`). Verify with the `*_ACCEPTED` lists, which
 * also carry the pre-rename values so a deploy does not invalidate live sessions
 * (access tokens live 30 minutes, refresh tokens up to a year).
 *
 * TODO(2026-12-01): delete the LEGACY_* values and the second entry of every
 * *_ACCEPTED list, then drop this file from tests/unit/branding-allowlist.json.
 * After that date tokens minted before the rename stop verifying (a one-time
 * forced re-login). Nothing else may spell the retired values.
 */
export const LEGACY_JWT_REMOVE_AFTER = '2026-12-01';

export const JWT_ISSUER = 'ebda-api';
export const JWT_AUDIENCE = 'ebda-app';
export const JWT_MFA_AUDIENCE = 'ebda-mfa-challenge';
export const JWT_WA_CART_AUDIENCE = 'ebda-wa-cart';

const LEGACY_JWT_ISSUER = 'force-api';
const LEGACY_JWT_AUDIENCE = 'force-app';
const LEGACY_JWT_MFA_AUDIENCE = 'force-mfa-challenge';
const LEGACY_JWT_WA_CART_AUDIENCE = 'force-wa-cart';

export const JWT_ISSUERS_ACCEPTED: [string, ...string[]] = [JWT_ISSUER, LEGACY_JWT_ISSUER];
export const JWT_AUDIENCES_ACCEPTED: [string, ...string[]] = [JWT_AUDIENCE, LEGACY_JWT_AUDIENCE];
export const JWT_MFA_AUDIENCES_ACCEPTED: [string, ...string[]] = [
  JWT_MFA_AUDIENCE,
  LEGACY_JWT_MFA_AUDIENCE,
];
export const JWT_WA_CART_AUDIENCES_ACCEPTED: [string, ...string[]] = [
  JWT_WA_CART_AUDIENCE,
  LEGACY_JWT_WA_CART_AUDIENCE,
];
