/**
 * Structured audit events for credential changes: one JSON line per event to the Worker log (Logpush / tail), never a
 * secret. Callers pass the event name and the user id only. The single console call lives here so call sites stay clean.
 */
export function logAuditEvent(event: string, userId: string): void {
  // eslint-disable-next-line no-console -- the one structured audit sink of this Worker
  console.info(JSON.stringify({ event, userId }));
}
