/**
 * Per-audience scope registry for integrator clients (identity contract v1.3). ONE place: creation validates against it and a
 * token request may only ask for a subset of what its client holds. An audience that is not listed here cannot have clients
 * (so `store`, `crm`, `erp` and any platform audience are refused until a ruling adds them).
 */
export const AUDIENCE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  whatsapp: [
    'conversations:read',
    'messages:send',
    'templates:read',
    'contacts:read',
    'contacts:write',
    'campaigns:read',
  ],
};

/** Named in the contract but not issuable yet; creation answers with a specific error instead of "unknown scope". */
export const RESERVED_SCOPES: readonly string[] = ['orders:events'];

export type ScopeCheck = { ok: true; scopes: string[] } | { ok: false; reason: string };

export function validateScopes(audience: string, requested: unknown): ScopeCheck {
  const allowed = AUDIENCE_SCOPES[audience];
  if (!allowed) return { ok: false, reason: 'INVALID_AUDIENCE' };
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > allowed.length)
    return { ok: false, reason: 'INVALID_SCOPE' };
  const out: string[] = [];
  for (const s of requested) {
    if (typeof s !== 'string') return { ok: false, reason: 'INVALID_SCOPE' };
    if (RESERVED_SCOPES.includes(s)) return { ok: false, reason: 'SCOPE_RESERVED' };
    if (!allowed.includes(s)) return { ok: false, reason: 'INVALID_SCOPE' };
    if (!out.includes(s)) out.push(s);
  }
  return { ok: true, scopes: out };
}
