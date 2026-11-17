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
const SITE_VERIFICATION_SCOPE = 'https://www.googleapis.com/auth/siteverification';
const GSC_WRITE_SCOPE = 'https://www.googleapis.com/auth/webmasters';
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

/** Anchored RE2 regex matching only pages served on exactly `host` (dots and other metacharacters escaped). */
// pq-allow(unused-export): test seam, imported by __tests__/gsc-target.test.ts (cross-store leak proof)
export function gscPageHostRegex(host: string): string {
  return `^https?://${host.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`;
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

/** A resolved GSC query target: the property to query, plus (parent-domain-property match only) the store host the `page` dimension must be restricted to. */
export interface GscTarget {
  siteUrl: string;
  /** Set only when `siteUrl` is a PARENT `sc-domain:` property of the store host: Search Analytics then needs a `page` filter so the store only sees its own host's rows. */
  pageHost?: string;
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * Pure: chooses the most specific accessible property that covers `host`.
 * Order: (1) exact `sc-domain:<host>`, (2) exact URL-prefix `https://<host>/`
 * (or http), (3) the LONGEST parent `sc-domain:<d>` where host ends with
 * `.<d>` — returned with `pageHost` so the caller filters by page. A sibling
 * label (`ab.ebda.app` vs `b.ebda.app`) never matches a parent because the
 * suffix test includes the dot. No match → null (caller skips, never throws).
 */
export function pickGscTarget(host: string, accessibleSiteUrls: string[]): GscTarget | null {
  const h = normalizeHost(host);
  if (!h) return null;
  const byLower = new Map(accessibleSiteUrls.map(u => [u.toLowerCase(), u] as const));

  for (const candidate of [`sc-domain:${h}`, `https://${h}/`, `http://${h}/`]) {
    const hit = byLower.get(candidate);
    if (hit) return { siteUrl: hit };
  }

  let best: { domain: string; siteUrl: string } | null = null;
  for (const [lower, original] of byLower) {
    if (!lower.startsWith('sc-domain:')) continue;
    const domain = lower.slice('sc-domain:'.length);
    if (!domain || !h.endsWith(`.${domain}`)) continue;
    if (!best || domain.length > best.domain.length) best = { domain, siteUrl: original };
  }
  return best ? { siteUrl: best.siteUrl, pageHost: h } : null;
}

/**
 * A token for the WRITE calls of domain verification (Site Verification API +
 * Search Console `sites.add`). Separate from the read-only ingest token so
 * the daily ingest never holds write scopes. Throws when unconfigured.
 */
export async function mintGscWriteToken(): Promise<string> {
  const creds = parseServiceAccount();
  if (!creds) {
    throw new Error('GSC is not configured (GSC_SERVICE_ACCOUNT_JSON missing/invalid)');
  }
  return mintAccessToken(creds, `${SITE_VERIFICATION_SCOPE} ${GSC_WRITE_SCOPE}`);
}

const SITES_CACHE_TTL_MS = 10 * 60 * 1000;
let sitesCache: { at: number; sites: string[] } | null = null;
let sitesInflight: Promise<string[]> | null = null;

/** Test hook: drop the cached `sites.list` result. */
export function resetGscSitesCache(): void {
  sitesCache = null;
  sitesInflight = null;
}

async function fetchAccessibleSites(): Promise<string[]> {
  const creds = parseServiceAccount();
  if (!creds) {
    throw new Error('GSC is not configured (GSC_SERVICE_ACCOUNT_JSON missing/invalid)');
  }
  const accessToken = await mintAccessToken(creds);
  const res = await fetchWithTimeout(SITES_API_BASE, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GSC sites.list failed with status ${res.status}`);
  const data: unknown = await res.json().catch(() => null);
  const entries = (data as { siteEntry?: unknown } | null)?.siteEntry;
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const e of entries) {
    const siteUrl = (e as { siteUrl?: unknown } | null)?.siteUrl;
    const level = (e as { permissionLevel?: unknown } | null)?.permissionLevel;
    // An unverified property answers 403 on every query — never a target.
    if (typeof siteUrl === 'string' && level !== 'siteUnverifiedUser') out.push(siteUrl);
  }
  return out;
}

/**
 * The properties the service account can query (`sites.list`), cached for 10
 * minutes so one cron run (one store per Inngest step) issues ONE list call,
 * not one per store. A failed list is NOT cached and throws (the per-store
 * wrapper isolates it).
 */
export async function listAccessibleGscSites(): Promise<string[]> {
  if (sitesCache && Date.now() - sitesCache.at < SITES_CACHE_TTL_MS) return sitesCache.sites;
  if (!sitesInflight) {
    sitesInflight = fetchAccessibleSites()
      .then(sites => {
        sitesCache = { at: Date.now(), sites };
        return sites;
      })
      .finally(() => {
        sitesInflight = null;
      });
  }
  return sitesInflight;
}

/** Resolves the GSC property (+ optional page filter) for a store host, or null when no accessible property covers it. */
export async function resolveGscTarget(host: string): Promise<GscTarget | null> {
  return pickGscTarget(host, await listAccessibleGscSites());
}

async function mintAccessToken(
  creds: ServiceAccountCreds,
  scope: string = GSC_SCOPE
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: creds.client_email,
      scope,
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
 * Queries Search Analytics for one GSC property (siteUrl, from `resolveGscTarget`) over [startDate, endDate] (YYYY-MM-DD).
 * Issues one `dimensions:['date']` call (daily rows) and one
 * `dimensions:['query']` call (top queries, capped at
 * `TOP_QUERIES_ROW_LIMIT`).
 *
 * `opts.pageHost` (parent-domain property only, from `resolveGscTarget`) adds
 * the `page` filter. Callers MUST guard on `isGscConfigured()` first — this throws a generic
 * Error if called while unconfigured (defense in depth, not the primary
 * guard). Throws `GscNoAccessError` on a 403 from either call (service
 * account not granted access to the property) so the cron can catch it
 * specifically and skip the domain. Any other malformed/empty response
 * degrades to a safe empty result — never throws for parse failures.
 */
export async function querySearchAnalytics(
  siteUrl: string,
  startDate: string,
  endDate: string,
  opts: { pageHost?: string } = {}
): Promise<GscResult> {
  const creds = parseServiceAccount();
  if (!creds) {
    throw new Error('GSC is not configured (GSC_SERVICE_ACCOUNT_JSON missing/invalid)');
  }

  const accessToken = await mintAccessToken(creds);

  // Parent-domain property: restrict to this store's host. An ANCHORED RE2
  // regex on the `page` dimension (`^https?://<escaped host>/`) — a plain
  // `contains` would also match another store's page whose path or query
  // carries this host (e.g. `https://x.ebda.app/?r=https://b.ebda.app/`),
  // leaking that store's clicks into this one. Anchoring at `^` also keeps
  // `ab.ebda.app` from matching `b.ebda.app`.
  const filter = opts.pageHost
    ? {
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'page',
                operator: 'includingRegex',
                expression: gscPageHostRegex(opts.pageHost),
              },
            ],
          },
        ],
      }
    : {};

  const [dateResult, queryResult] = await Promise.all([
    postSearchAnalytics(siteUrl, accessToken, {
      startDate,
      endDate,
      dimensions: ['date'],
      ...filter,
    }),
    postSearchAnalytics(siteUrl, accessToken, {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: TOP_QUERIES_ROW_LIMIT,
      ...filter,
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
