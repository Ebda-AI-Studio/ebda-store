/**
 * Hourly alert over the `ebda_request_budget` dataset (NEON-ZERO 9.2 "Alert"): reads the last hour through the Analytics Engine SQL
 * API and sends ONE P1 per breaching route when its weighted p95 latency is over P95_BUDGET_MS or its 5xx rate is over ERROR_RATE_MAX
 * (both only with >= MIN_REQUESTS weighted requests, so a quiet route cannot page). sendAlert reaches the brain through the existing
 * mirror and throttles identical (level, title) pairs.
 *
 * Needs the Worker secrets CF_ANALYTICS_ACCOUNT_ID + CF_ANALYTICS_TOKEN (an Account Analytics:Read token). Unset = skipped and
 * reported as such, never an error (a missing secret must not break the hourly cron).
 *
 * Dedupe PER INCIDENT, not per hour: sendAlert only throttles 5 minutes, so a sustained breach would page every hourly tick. The set of
 * routes currently alerted lives in KV (`request-budget-alerted`); a route in it is not re-alerted until a later run sees it HEALTHY
 * (present in the result and under budget). A route absent from the result (traffic below MIN_REQUESTS) keeps its state: no data is not
 * recovery. An alert that did not go out ('failed' / 'skipped') is not recorded, so the next tick retries it.
 * Cost if wrong: a lost state row (KV unbound or expired after 3 days) re-alerts a standing breach once; never a missed first alert.
 */
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings, type KVNamespaceLike } from '../cf/bindings';

const P95_BUDGET_MS = 1500;
const ERROR_RATE_MAX = 0.05;
const MIN_REQUESTS = 200;

interface RouteStat {
  route: string;
  requests: number;
  p95Ms: number;
  errors5xx: number;
}

const BUDGET_SQL = `SELECT index1 AS route,
  sum(double1 * _sample_interval) AS requests,
  quantileWeighted(0.95)(double2, toUInt32(double1 * _sample_interval)) AS p95_ms,
  sumIf(double1 * _sample_interval, blob3 = '5xx') AS errors_5xx
FROM ebda_request_budget WHERE timestamp > NOW() - INTERVAL '1' HOUR GROUP BY route HAVING requests >= ${MIN_REQUESTS} FORMAT JSON`;

export function breaches(stats: RouteStat[]): Array<{ route: string; reason: string }> {
  const out: Array<{ route: string; reason: string }> = [];
  for (const s of stats) {
    if (s.requests < MIN_REQUESTS) continue;
    if (s.p95Ms > P95_BUDGET_MS)
      out.push({ route: s.route, reason: `p95 ${Math.round(s.p95Ms)} ms > ${P95_BUDGET_MS} ms` });
    else if (s.errors5xx / s.requests > ERROR_RATE_MAX)
      out.push({
        route: s.route,
        reason: `5xx rate ${((s.errors5xx / s.requests) * 100).toFixed(1)}% > ${ERROR_RATE_MAX * 100}%`,
      });
  }
  return out;
}

const ALERTED_KEY = 'request-budget-alerted';
const ALERTED_TTL_S = 3 * 86_400;

interface AlertedStore {
  get(): Promise<string[]>;
  put(routes: string[]): Promise<void>;
}

function kvAlertedStore(
  kv: Pick<KVNamespaceLike, 'get' | 'put'> | undefined = cfBindings()?.KV_CACHE
): AlertedStore | undefined {
  if (!kv) return undefined;
  return {
    async get() {
      try {
        const v = JSON.parse((await kv.get(ALERTED_KEY)) ?? '[]');
        return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
      } catch {
        return [];
      }
    },
    put: routes => kv.put(ALERTED_KEY, JSON.stringify(routes), { expirationTtl: ALERTED_TTL_S }),
  };
}

export async function runRequestBudgetAlert(
  env: { accountId?: string; token?: string } = {
    accountId: process.env.CF_ANALYTICS_ACCOUNT_ID,
    token: process.env.CF_ANALYTICS_TOKEN,
  },
  fetchImpl: typeof fetch = fetch,
  send: typeof sendAlert = sendAlert,
  state: AlertedStore | undefined = kvAlertedStore()
): Promise<{ skipped: boolean; alerted: number }> {
  if (!env.accountId || !env.token) return { skipped: true, alerted: 0 };
  const res = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/analytics_engine/sql`,
    { method: 'POST', headers: { authorization: `Bearer ${env.token}` }, body: BUDGET_SQL }
  );
  if (!res.ok) throw new Error(`analytics engine sql ${res.status}`);
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const stats: RouteStat[] = (body.data ?? []).map(r => ({
    route: String(r.route),
    requests: Number(r.requests),
    p95Ms: Number(r.p95_ms),
    errors5xx: Number(r.errors_5xx),
  }));
  const hits = breaches(stats);
  const breaching = new Set(hits.map(h => h.route));
  const seen = new Set(stats.map(s => s.route));
  const prev = new Set(state ? await state.get() : []);
  // Next state: still breaching + recorded earlier and not seen healthy (no data keeps its state).
  const next = new Set<string>([...prev].filter(r => breaching.has(r) || !seen.has(r)));
  let alerted = 0;
  for (const h of hits) {
    if (prev.has(h.route)) continue; // same incident, already paged
    const outcome = await send({
      level: 'p1',
      source: 'cron.request-budget',
      title: `Route over its request budget: ${h.route}`,
      body: `${h.route}: ${h.reason} over the last hour (dataset ebda_request_budget, weighted sample). Not re-alerted until it recovers.`,
    }).catch(err => {
      logger.warn({ err }, '[request-budget] alert send failed');
      return 'failed' as const;
    });
    if (outcome === 'sent' || outcome === 'throttled') next.add(h.route);
    if (outcome === 'sent') alerted++;
  }
  if (state)
    await state
      .put([...next])
      .catch(err => logger.warn({ err }, '[request-budget] state write failed'));
  return { skipped: false, alerted };
}
