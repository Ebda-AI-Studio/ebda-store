import type { NextFunction, Request, Response } from 'express';

/**
 * Read-only window for the Postgres to Cloudflare cutover (docs/runbooks/cutover-cf.md section 5).
 *
 * With WRITES_FROZEN=1 every non-read request answers 503 + Retry-After, so no row can change between the
 * final dump and the backend flip. Reads, the health probes and the Sentry/alert webhook stay open. The
 * variable is read per request; flip it with a Worker var change and a deploy. It is OFF unless set to
 * exactly "1": a typo can never freeze production.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT = [
  /^\/health(\/|$)/,
  /^\/api\/v1\/health(\/|$)/,
  /^\/api\/v1\/alerts\/webhooks(\/|$)/,
];

export function writeFreeze(req: Request, res: Response, next: NextFunction): void {
  if (process.env.WRITES_FROZEN !== '1' || READ_METHODS.has(req.method)) return next();
  if (EXEMPT.some(re => re.test(req.path))) return next();
  res.setHeader('Retry-After', '300');
  res.status(503).json({
    success: false,
    error: {
      code: 'READ_ONLY_WINDOW',
      message:
        'The service is moving to new infrastructure. Reads work; try again in a few minutes.',
    },
  });
}
