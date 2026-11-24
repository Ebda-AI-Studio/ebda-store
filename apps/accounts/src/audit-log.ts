/**
 * Structured events: one JSON line per event to the Worker log (Logpush / tail), never a secret. Callers pass an event name
 * and non-secret fields only (a user id, public key ids). The single console call lives here so call sites stay clean.
 */
export function logEvent(
  event: string,
  fields: Record<string, string | string[]> = {},
  level: 'info' | 'error' = 'info'
): void {
  // eslint-disable-next-line no-console -- the one structured sink of this Worker
  (level === 'error' ? console.error : console.info)(JSON.stringify({ event, ...fields }));
}

/** Credential-change audit event: the event name and the user id only. */
export function logAuditEvent(event: string, userId: string): void {
  logEvent(event, { userId });
}
