/**
 * Google Search Console (GSC) client — Search Analytics, service-account
 * auth (Plan 8B, Task 2). DORMANT until credentialed: with no
 * `GSC_SERVICE_ACCOUNT_JSON` env set, `isGscConfigured()` reports false and
 * callers (later tasks' cron) must guard on it before ever reaching
 * `querySearchAnalytics` — mirrors how Plan 8A's paid answer-engine
 * providers stay dormant until an admin sets a key.
 *
 * Auth: Force manages a single Google SERVICE ACCOUNT (confirmed by Ahmad,
 * not per-merchant OAuth). We mint our own OAuth2 access token via the
 * standard "JWT Bearer" service-account flow — sign a short-lived RS256
 * assertion with the account's private key, POST it to Google's token
 * endpoint, and use the returned `access_token` as a Bearer token against
 * the Search Analytics API:
 *   https://developers.google.com/identity/protocols/oauth2/service-account
 *
 * Dependency decision (documented per task brief): `jsonwebtoken` is
 * ALREADY a dependency of apps/api (used throughout for our own session
 * JWTs — see src/middleware/auth.ts, src/services/auth.service.ts, etc.)
 * and supports RS256 signing out of the box, so it is reused here to sign
 * the assertion. No new dependency (e.g. `google-auth-library`) was added.
 *
 * GSC Search Analytics `query` request/response shape (current as of
 * 2026-07): POST .../searchAnalytics/query with
 *   { startDate, endDate, dimensions: ['date' | 'query'], rowLimit? }
 * Response: `{ rows?: [{ keys: string[], clicks, impressions, ctr,
 * position }] }`. This is untrusted third-party output — every field is
 * parsed defensively; a missing/malformed `rows` degrades to `[]`, never
 * throws.
 *
 * A 403 response means the service account has not been granted access to
 * that GSC property (a per-property admin action outside our control) —
 * this is surfaced as a typed `GscNoAccessError` so the cron can catch it
 * specifically and SKIP that domain, rather than treating it as a generic
 * failure.
 *
 * The service-account private key is NEVER logged. Parse failures log a
 * generic message only.
 */
import jwt from 'jsonwebtoken';
import logger from '../../lib/logger';
import { fetchWithTimeout } from '../../lib/fetch-timeout';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SITES_API_BASE = 'https://www.googleapis.com/webmasters/v3/sites';
const TOP_QUERIES_ROW_LIMIT = 10;
const ACCESS_TOKEN_TTL_SECONDS = 3600;

interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
}

export interface GscDateRow {
  date: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

export interface GscTopQuery {
  query: string;
  impressions: number;
  clicks: number;
}

export interface GscResult {
  dateRows: GscDateRow[];
  topQueries: GscTopQuery[];
}

/** Thrown when the service account has no access to a GSC property (403). Callers (cron) should catch this specifically and skip the domain. */
export class GscNoAccessError extends Error {
  constructor(siteUrl: string) {
    super(`GSC service account lacks access to property: ${siteUrl}`);
    this.name = 'GscNoAccessError';
  }
}

/** Parses + validates GSC_SERVICE_ACCOUNT_JSON. Never logs the raw value (may contain the private key). Returns null on anything unset/malformed/incomplete. */
function parseServiceAccount(): ServiceAccountCreds | null {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error('GSC_SERVICE_ACCOUNT_JSON is not valid JSON');
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const clientEmail = (parsed as { client_email?: unknown }).client_email;
  const privateKey = (parsed as { private_key?: unknown }).private_key;
  if (
    typeof clientEmail === 'string' &&
    clientEmail.length > 0 &&
    typeof privateKey === 'string' &&
    privateKey.length > 0
  ) {
    return { client_email: clientEmail, private_key: privateKey };
  }

  logger.error('GSC_SERVICE_ACCOUNT_JSON is missing client_email/private_key');
  return null;
}

/** True iff GSC_SERVICE_ACCOUNT_JSON parses to an object with client_email + private_key. The cron must guard on this before calling querySearchAnalytics. */
export function isGscConfigured(): boolean {
  return parseServiceAccount() !== null;
}

/** Normalizes a domain (lowercase, strip leading www.) and returns both GSC property URL forms the cron should try in order: the domain-property form and the URL-prefix form. */
export function gscSiteUrlsForDomain(domain: string): string[] {
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  return [`sc-domain:${normalized}`, `https://${normalized}/`];
}

async function mintAccessToken(creds: ServiceAccountCreds): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: creds.client_email,
      scope: GSC_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: nowSeconds,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    },
    creds.private_key,
    { algorithm: 'RS256' }
  );

  const res = await fetchWithTimeout(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    // Never log the assertion/key — status only.
    throw new Error(`GSC token mint failed with status ${res.status}`);
  }

  const data: unknown = await res.json().catch(() => null);
  const accessToken = (data as { access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('GSC token mint response missing access_token');
  }
  return accessToken;
}

type SearchAnalyticsPostResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number };

async function postSearchAnalytics(
  siteUrl: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<SearchAnalyticsPostResult> {
  const url = `${SITES_API_BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error({ err }, 'GSC Search Analytics request failed (network error)');
    return { ok: false, status: 0 };
  }

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  try {
    const data: unknown = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    logger.error({ err }, 'Failed to parse GSC Search Analytics response body');
    return { ok: false, status: res.status };
  }
}

function toSafeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function extractRows(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== 'object') return [];
  const rows = (data as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

function parseDateRows(data: unknown): GscDateRow[] {
  const out: GscDateRow[] = [];
  for (const row of extractRows(data)) {
    const keys = row.keys;
    const date = Array.isArray(keys) && typeof keys[0] === 'string' ? keys[0] : undefined;
    if (!date) continue;
    out.push({
      date,
      impressions: toSafeNumber(row.impressions),
      clicks: toSafeNumber(row.clicks),
      ctr: toSafeNumber(row.ctr),
      position: toSafeNumber(row.position),
    });
  }
  return out;
}

function parseTopQueries(data: unknown): GscTopQuery[] {
  const out: GscTopQuery[] = [];
  for (const row of extractRows(data)) {
    const keys = row.keys;
    const query = Array.isArray(keys) && typeof keys[0] === 'string' ? keys[0] : undefined;
    if (!query) continue;
    out.push({
      query,
      impressions: toSafeNumber(row.impressions),
      clicks: toSafeNumber(row.clicks),
    });
  }
  return out;
}

/**
 * Queries Search Analytics for one GSC property (siteUrl — one of the two
 * forms from `gscSiteUrlsForDomain`) over [startDate, endDate] (YYYY-MM-DD).
 * Issues one `dimensions:['date']` call (daily rows) and one
 * `dimensions:['query']` call (top queries, capped at
 * `TOP_QUERIES_ROW_LIMIT`).
 *
 * Callers MUST guard on `isGscConfigured()` first — this throws a generic
 * Error if called while unconfigured (defense in depth, not the primary
 * guard). Throws `GscNoAccessError` on a 403 from either call (service
 * account not granted access to the property) so the cron can catch it
 * specifically and skip the domain. Any other malformed/empty response
 * degrades to a safe empty result — never throws for parse failures.
 */
export async function querySearchAnalytics(
  siteUrl: string,
  startDate: string,
  endDate: string
): Promise<GscResult> {
  const creds = parseServiceAccount();
  if (!creds) {
    throw new Error('GSC is not configured (GSC_SERVICE_ACCOUNT_JSON missing/invalid)');
  }

  const accessToken = await mintAccessToken(creds);

  const [dateResult, queryResult] = await Promise.all([
    postSearchAnalytics(siteUrl, accessToken, {
      startDate,
      endDate,
      dimensions: ['date'],
    }),
    postSearchAnalytics(siteUrl, accessToken, {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: TOP_QUERIES_ROW_LIMIT,
    }),
  ]);

  if (
    (!dateResult.ok && dateResult.status === 403) ||
    (!queryResult.ok && queryResult.status === 403)
  ) {
    throw new GscNoAccessError(siteUrl);
  }

  return {
    dateRows: dateResult.ok ? parseDateRows(dateResult.data) : [],
    topQueries: queryResult.ok ? parseTopQueries(queryResult.data) : [],
  };
}
