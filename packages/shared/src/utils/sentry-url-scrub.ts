/**
 * Redacts the VALUES of free-text query parameters (search box, typeahead, lookups by email or
 * phone) from URLs before they leave our process: Sentry events, transactions and breadcrumbs
 * (every app) and the API's own log lines.
 *
 * Why (search program P0 Task 5 review, fix-the-class): a shopper pastes a phone or an email
 * into the storefront search box, it travels as `?search=01012345678` / `?q=…`, and the SDKs
 * record the full URL (`event.request.url` / `query_string`, navigation + fetch breadcrumbs,
 * span `url.full` / `http.query`, the transaction name). The search log drops such terms; the
 * URL copies of the same value must not reach a third party either.
 *
 * Keys only, values replaced by `[Filtered]` (Sentry's own placeholder); the rest of the URL
 * (path, page, sort, ids) stays readable for debugging. Pure, no SDK import, unit-tested.
 */

/** Query parameters whose value is free text a person typed (case-insensitive). */
export const SENSITIVE_QUERY_PARAMS = [
  'search',
  'q',
  'query',
  'term',
  'keyword',
  'keywords',
  'email',
  'phone',
] as const;

export const REDACTED_QUERY_VALUE = '[Filtered]';

const SENSITIVE = new Set<string>(SENSITIVE_QUERY_PARAMS);
// `?key=value` / `&key=value` anywhere in a string (absolute or relative URL, a log message);
// also a bare query string `key=value&…` at the very start.
const PARAM_RE = /(^|[?&])([^=&#?\s]+)=([^&#\s]*)/g;

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    return key.toLowerCase();
  }
}

/** Replace the value of every sensitive query parameter in `text` with `[Filtered]`. */
export function redactSensitiveQuery(text: string): string {
  if (typeof text !== 'string' || !text.includes('=')) return text;
  return text.replace(PARAM_RE, (whole, lead: string, key: string, value: string) => {
    if (!value || !SENSITIVE.has(decodeKey(key))) return whole;
    return `${lead}${key}=${REDACTED_QUERY_VALUE}`;
  });
}

const MAX_DEPTH = 8;

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSensitiveQuery(value);
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    // `query_string` as `[key, value][]` pairs.
    if (
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      SENSITIVE.has(value[0].toLowerCase())
    ) {
      value[1] = REDACTED_QUERY_VALUE;
      return value;
    }
    for (let i = 0; i < value.length; i++) value[i] = scrubValue(value[i], depth + 1, seen);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    obj[key] = scrubValue(obj[key], depth + 1, seen);
  }
  // `query_string` as an object (`{ search: '…' }`).
  const qs = obj.query_string;
  if (qs && typeof qs === 'object' && !Array.isArray(qs)) {
    const q = qs as Record<string, unknown>;
    for (const key of Object.keys(q)) {
      if (SENSITIVE.has(key.toLowerCase()) && q[key]) q[key] = REDACTED_QUERY_VALUE;
    }
  }
  return value;
}

/**
 * Scrub a Sentry event / transaction in place (every string, at any depth: request URL and
 * query string, breadcrumbs, spans, contexts, extra, transaction name). Use as `beforeSend`
 * and `beforeSendTransaction`. Returns the same object.
 */
export function scrubSentryEvent<T>(event: T): T {
  return scrubValue(event, 0, new WeakSet()) as T;
}

/** `beforeBreadcrumb`: scrub navigation / fetch / xhr / console breadcrumbs. */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  return scrubValue(breadcrumb, 0, new WeakSet()) as T;
}
