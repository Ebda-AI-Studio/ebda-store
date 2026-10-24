/** `event.data.storeId`-style lookup used by concurrency / debounce / idempotency keys. */
export function readPath(root: unknown, expr: string | undefined): string | undefined {
  if (!expr) return undefined;
  let cur: unknown = root;
  for (const part of expr.replace(/^event\./, 'event.').split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined || cur === null) return undefined;
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean'
    ? String(cur)
    : undefined;
}

/** `event.data.x` against a JobEvent. */
export function readEventKey(event: { name: string; data?: unknown; id?: string }, expr?: string) {
  return readPath({ event }, expr);
}

/** Workflow instance ids: [A-Za-z0-9_-], <= 100 chars. */
export async function instanceId(parts: string[]): Promise<string> {
  const raw = parts.join('--');
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe.length <= 100) return safe;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${safe.slice(0, 40)}-${hex.slice(0, 40)}`;
}
