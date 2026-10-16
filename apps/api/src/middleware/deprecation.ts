import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';
import { BoundedMap } from '../lib/bounded-map';
import { redactSensitiveQuery } from '@ebda/shared';

/**
 * Endpoint deprecation signalling.
 *
 * `/api/v1` has been the prefix since launch, but a version prefix alone is not
 * a deprecation policy: it says which contract you are on, not that the one you
 * are on is going away. Consumers outside this repo — merchant integrations and
 * the WBS bridge — had no mechanism to learn that an endpoint was retiring
 * until it 404'd (audited 2026-08-31, lens L15,
 * `docs/audits/2026-08-31-reel-derived-lenses.md`).
 *
 * This emits the two standard headers so a client can find out on its own:
 *
 *   Deprecation: @<unix-seconds> RFC 9745 sf-date — when the endpoint became deprecated
 *   Sunset:      <IMF-fixdate>   RFC 8594 — when it will stop responding
 *   Link: <successor>; rel="successor-version"
 *
 * It also logs each call at WARN with the caller's identity, which is the part
 * that actually matters operationally: you cannot retire an endpoint you cannot
 * prove is unused, and "nobody complained" is not evidence — the whole failure
 * mode here is a consumer that never finds out.
 */

export interface DeprecationOptions {
  /** When the endpoint was marked deprecated. */
  since: Date;
  /** When it stops responding. MUST be a real, planned date, not aspirational. */
  sunset: Date;
  /** Replacement path, e.g. '/api/v1/products?include=variants'. Omit if none. */
  successor?: string;
  /** Short reason, surfaced in the log line so triage does not need this file. */
  reason: string;
}

/**
 * Express middleware marking one route deprecated.
 *
 * ```ts
 * router.get(
 *   '/legacy-thing',
 *   deprecate({
 *     since: new Date('2026-09-01'),
 *     sunset: new Date('2026-12-01'),
 *     successor: '/api/v1/new-thing',
 *     reason: 'superseded by /new-thing, which is tenant-scoped',
 *   }),
 *   handler
 * );
 * ```
 *
 * Deliberately does NOT block the request: a sunset date that starts returning
 * 410 early is an outage, not a policy. Enforcement is removing the route on
 * the sunset date, as a normal reviewed change.
 */
// Last time each `<method> <path>` combination logged a WARN, keyed so one
// hot deprecated endpoint can't flood the log at request volume. Capped —
// losing the oldest entry just means that route logs once more than
// strictly necessary, never a durability concern.
const lastWarnedAt = new BoundedMap<string, number>(500);
const WARN_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/** Test-only: clear the per-route sample state between test cases. */
export function __resetDeprecationWarnSampleForTests(): void {
  lastWarnedAt.clear();
}

export function deprecate(opts: DeprecationOptions) {
  if (opts.sunset <= opts.since) {
    // Fail at boot, not at request time — a sunset before its own deprecation
    // date is a typo, and one that would otherwise ship silently.
    throw new Error(
      `deprecate(): sunset (${opts.sunset.toISOString()}) must be after since (${opts.since.toISOString()})`
    );
  }

  return function deprecationHeaders(req: Request, res: Response, next: NextFunction): void {
    // Sunset (RFC 8594) takes an IMF-fixdate. Deprecation (RFC 9745) takes an
    // sf-date — `@<unix-seconds>`, NOT an IMF-fixdate; the two RFCs disagree
    // on format even though both mark dates.
    res.setHeader('Deprecation', `@${Math.floor(opts.since.getTime() / 1000)}`);
    res.setHeader('Sunset', opts.sunset.toUTCString());
    if (opts.successor) {
      res.setHeader('Link', `<${opts.successor}>; rel="successor-version"`);
    }

    // WARN, not INFO: this exists to be noticed. Identify the caller so the
    // endpoint can actually be retired rather than left "just in case".
    // Sampled per route (method+path) so a hot deprecated endpoint logs at
    // most once per interval instead of once per request.
    const routeKey = `${req.method} ${req.route?.path ?? req.originalUrl}`;
    const now = Date.now();
    const lastWarned = lastWarnedAt.get(routeKey);
    if (lastWarned === undefined || now - lastWarned >= WARN_SAMPLE_INTERVAL_MS) {
      lastWarnedAt.set(routeKey, now);
      logger.warn(
        {
          path: redactSensitiveQuery(req.originalUrl),
          method: req.method,
          sunset: opts.sunset.toISOString(),
          reason: opts.reason,
          // Best-effort caller identity — whichever the integration presents.
          callerStore: (req.params as Record<string, string> | undefined)?.storeId,
          userAgent: req.headers['user-agent'],
          origin: req.headers.origin,
        },
        '[deprecated-endpoint] called'
      );
    }

    next();
  };
}

/**
 * Currently deprecated endpoints.
 *
 * Empty by design: this ships the mechanism, not a deprecation. Add an entry
 * here at the same time as the `deprecate()` call so there is one list to read
 * before changing a contract — a policy whose only record is scattered
 * middleware calls is one nobody can audit.
 *
 * | Endpoint | Since | Sunset | Successor | Reason |
 * | --- | --- | --- | --- | --- |
 * | _(none)_ | | | | |
 */
export const DEPRECATED_ENDPOINTS: readonly DeprecationOptions[] = [];
