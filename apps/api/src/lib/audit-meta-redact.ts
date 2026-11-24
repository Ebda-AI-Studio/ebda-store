/**
 * `platform_audit_log.meta` is free JSON and can carry personal data (an e-mail, a phone, an ip, a name, a before/after profile diff, a
 * free-text reason). It is classified personal (erasure-classification.json) and these top-level keys are removed, by SQL
 * `json_remove`, on a user erasure (rows the user acted on or was the target of) and when a store is purged (every row of the store).
 * What stays: the action, the target, the time and any other key (a plan code, a status, an id). Nested objects are removed whole when
 * they sit under one of these keys; a personal value under any OTHER key is not found here (known limit: new audit writers must not put
 * personal data in meta; the classification names the column personal so a reviewer is prompted).
 */
// pq-allow(unused-export): test seam, imported by tests/unit/audit-meta-redaction.test.ts
export const AUDIT_META_PII_KEYS = [
  'email',
  'phone',
  'mobile',
  'ip',
  'ipAddress',
  'ip_address',
  'userAgent',
  'user_agent',
  'name',
  'firstName',
  'lastName',
  'fullName',
  'address',
  'payer',
  'payerName',
  'before',
  'after',
  'reason',
  'note',
  'message',
] as const;

/** `json_remove(meta, '$."email"', ...)`: the expression only, apply it where `json_valid(meta)`. */
export const redactedMetaSql = (column = 'meta'): string =>
  `json_remove("${column}", ${AUDIT_META_PII_KEYS.map(k => `'$."${k}"'`).join(', ')})`;
