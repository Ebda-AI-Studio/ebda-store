/**
 * Redacts the VALUES of free-text query parameters (search box, typeahead, lookups by email or
 * phone) from URLs before they leave our process: Sentry events, transactions and breadcrumbs
 * (every app), PostHog captures (every app) and the API's own log lines.
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
// also a bare query string `key=value&…` at the very start. A value stops at a DOUBLE quote so a
// PostHog `$elements_chain` string (`a:attr__href="/search?q=abc"nth-child="1"`) is not swallowed
// whole by its first `key="` pair, which would hide the inner `?q=`. Never at an apostrophe:
// `encodeURIComponent` leaves `'` raw, and Franco-Arabic search terms use it as a letter (`3'` =
// غ, `7'` = خ), so `?q=O'Brien%2001012345678` must redact whole. A raw `"` cannot occur inside a
// value (encodeURIComponent / URLSearchParams / the WHATWG URL parser all encode it).
const PARAM_RE = /(^|[?&])([^=&#?\s]+)=([^&#\s"]*)/g;

/** Lower-cased, decoded key with any array suffix (`q[]`, `q[0]`) removed. */
function normalizeKey(key: string): string {
  let k: string;
  try {
    k = decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    k = key;
  }
  return k.toLowerCase().replace(/\[[^\]]*\]$/, '');
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(normalizeKey(key));
}

/** Replace the value of every sensitive query parameter in `text` with `[Filtered]`. */
export function redactSensitiveQuery(text: string): string {
  if (typeof text !== 'string' || !text.includes('=')) return text;
  return text.replace(PARAM_RE, (whole, lead: string, key: string, value: string) => {
    if (!value || !isSensitiveKey(key)) return whole;
    return `${lead}${key}=${REDACTED_QUERY_VALUE}`;
  });
}

const MAX_DEPTH = 16;

/**
 * Write `next` into `container[key]`; if the container is frozen / read-only, switch to a
 * shallow copy (copy-on-write) and write there. Returns the container to keep using.
 */
function put<C extends object>(container: C, key: string | number, next: unknown, original: C): C {
  if (container === original && (Object.isFrozen(container) || !isWritable(container, key))) {
    container = (Array.isArray(container) ? [...container] : { ...container }) as C;
  }
  (container as Record<string | number, unknown>)[key] = next;
  return container;
}

function isWritable(obj: object, key: string | number): boolean {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return !d || d.writable === true || typeof d.set === 'function';
}

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
      isSensitiveKey(value[0])
    ) {
      return put(value, 1, REDACTED_QUERY_VALUE, value);
    }
    let out: unknown[] = value;
    for (let i = 0; i < value.length; i++) {
      const next = scrubValue(value[i], depth + 1, seen);
      if (next !== value[i]) out = put(out, i, next, value);
    }
    return out;
  }
  const obj = value as Record<string, unknown>;
  let out: Record<string, unknown> = obj;
  for (const key of Object.keys(obj)) {
    const next = scrubValue(obj[key], depth + 1, seen);
    if (next !== obj[key]) out = put(out, key, next, obj);
  }
  // `query_string` as an object (`{ search: '…' }`).
  const qs = out.query_string;
  if (qs && typeof qs === 'object' && !Array.isArray(qs)) {
    const q = qs as Record<string, unknown>;
    let q2: Record<string, unknown> = q;
    for (const key of Object.keys(q)) {
      if (isSensitiveKey(key) && q[key]) q2 = put(q2, key, REDACTED_QUERY_VALUE, q);
    }
    if (q2 !== q) out = put(out, 'query_string', q2, obj);
  }
  return out;
}

/**
 * Scrub a Sentry event / transaction (every string, at any depth: request URL and query
 * string, breadcrumbs, spans, contexts, extra, transaction name). Use as `beforeSend` and
 * `beforeSendTransaction`. Mutates in place where it can; a frozen object is copied instead
 * (copy-on-write), so use the RETURN value.
 */
export function scrubSentryEvent<T>(event: T): T {
  return scrubValue(event, 0, new WeakSet()) as T;
}

/** `beforeBreadcrumb`: scrub navigation / fetch / xhr / console breadcrumbs. */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  return scrubValue(breadcrumb, 0, new WeakSet()) as T;
}

/**
 * PostHog `before_send`: scrub a capture result (`$current_url`, `$referrer`,
 * `$initial_current_url` / `$initial_referrer` in `$set_once`, custom URL props, exception
 * values). A `/search?q=<phone>` pageview leaves as `/search?q=[Filtered]`. Null passes through
 * (an earlier hook dropped the event).
 */
export function scrubPostHogCapture<T>(capture: T | null): T | null {
  return capture == null ? capture : (scrubValue(capture, 0, new WeakSet()) as T);
}
