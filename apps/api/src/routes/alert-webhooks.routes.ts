import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod/v3';
import logger from '../lib/logger';
import { sendAlert } from '../services/alerts.service';

const router = Router();

// S7 (2026-11-12 audit): the secret is read PER REQUEST (a rotated `wrangler secret` takes effect without a
// redeploy, and a Worker isolate that booted before the secret existed does not stay stuck open/closed), and it is
// accepted from the `x-alerts-token` HEADER ONLY. A `?token=` query string lands in access logs, Sentry breadcrumbs
// and proxies, so a request that carries it and no header is refused (and logged WITHOUT the value).
const alertsToken = (): string | undefined => process.env.ALERTS_WEBHOOK_TOKEN || undefined;

/** Boot/health check: warn loudly when the token is unset in production (CLAUDE.md rule 12). Fail-closed at request time. */
function alertsBridgeConfigured(): boolean {
  return alertsToken() !== undefined;
}
if (!alertsBridgeConfigured() && process.env.NODE_ENV === 'production') {
  logger.error(
    { rule: 'CLAUDE.md#12', endpoint: '/api/v1/alerts/webhooks/*' },
    'ALERTS_WEBHOOK_TOKEN is unset in production — webhook bridge rejects every call (fail closed). Set it with `wrangler secret put ALERTS_WEBHOOK_TOKEN --name ebda-api`; until then the bridge refuses every call.'
  );
}

function reject(res: Response, status: number, code: string, message: string): false {
  res.status(status).json({ ok: false, success: false, error: { code, message } });
  return false;
}

function requireToken(req: Request, res: Response): boolean {
  const expected = alertsToken();
  if (!expected) {
    // Fail CLOSED in production: an unset token used to mean "accept any payload", so anyone could post fake
    // alerts to the operator's Telegram. Dev / preview keep the convenience of no token.
    if (process.env.NODE_ENV === 'production') {
      return reject(res, 503, 'alerts_not_configured', 'Alerts webhook token is not configured.');
    }
    return true;
  }
  const token = req.header('x-alerts-token') || '';
  if (!token) {
    if (req.query.token !== undefined) {
      logger.warn(
        { endpoint: req.path },
        'alerts bridge: ?token= query auth refused (S7); send the secret in the x-alerts-token header'
      );
      return reject(
        res,
        401,
        'token_in_query_refused',
        'Send the alerts webhook token in the x-alerts-token header, not the query string.'
      );
    }
    return reject(res, 401, 'invalid_token', 'Missing or invalid alerts webhook token.');
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return reject(res, 401, 'invalid_token', 'Missing or invalid alerts webhook token.');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Payload schemas. These are third-party webhook bodies (Sentry, Axiom,
// PostHog, Railway) we do not control, and a rejected alert is a LOST alert —
// so every field is optional and a wrongly-typed field degrades to `undefined`
// (`.catch`) instead of failing the request. What the schema buys is that a
// field is a string/number/object before the handler touches it: `title: 123`
// used to reach `.slice()` and 500, and a non-object body crashed the property
// reads. Never tighten these to `.strict()`/required fields without checking
// the provider's real payload.
// ---------------------------------------------------------------------------
const optStr = z.string().optional().catch(undefined);
const optNum = z.number().optional().catch(undefined);
const optObj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).optional().catch(undefined);

const SENTRY_ALERT_ACTIONS = new Set(['created', 'triggered']);

const sentryBodySchema = z
  .object({
    action: optStr,
    data: optObj({
      issue: optObj({
        title: optStr,
        web_url: optStr,
        level: optStr,
        project: optObj({ slug: optStr }),
      }),
      // Alert-rule action payload (internal integration, action "triggered").
      event: optObj({
        title: optStr,
        web_url: optStr,
        level: optStr,
        project: optObj({ slug: optStr }),
      }),
    }),
    event: optObj({ title: optStr, web_url: optStr, level: optStr, environment: optStr }),
  })
  .catch({});

const axiomBodySchema = z
  .object({
    monitor: optObj({ name: optStr, type: optStr, description: optStr }),
    match: optObj({ count: optNum, value: optNum }),
    description: optStr,
    url: optStr,
    timestamp: optStr,
  })
  .catch({});

const posthogBodySchema = z
  .object({
    insight: optObj({ name: optStr, short_id: optStr }),
    alert: optObj({ name: optStr }),
    matches: z.array(z.unknown()).optional().catch(undefined),
  })
  .catch({});

const railwayBodySchema = z
  .object({
    type: optStr,
    timestamp: optStr,
    project: optObj({ id: optStr, name: optStr }),
    environment: optObj({ id: optStr, name: optStr }),
    deployment: optObj({
      id: optStr,
      status: optStr,
      creator: optObj({ name: optStr }),
      meta: optObj({ commitMessage: optStr, commitAuthor: optStr }),
    }),
  })
  .catch({});

const genericBodySchema = z
  .object({
    title: optStr,
    body: optStr,
    level: z.enum(['p0', 'p1', 'info']).optional().catch(undefined),
    source: optStr,
  })
  .catch({});

router.post('/sentry', async (req, res, next) => {
  try {
    if (!requireToken(req, res)) return;
    const body = sentryBodySchema.parse(req.body);
    // Issue webhooks fire on every lifecycle change (created, resolved,
    // assigned, archived...). Only a NEW issue or a triggered alert rule is an
    // alert; the rest are acknowledged and dropped so Telegram stays signal.
    if (body.action && !SENTRY_ALERT_ACTIONS.has(body.action)) {
      res.json({ ok: true, ignored: body.action });
      return;
    }
    const issue = body.data?.issue ?? body.data?.event ?? body.event ?? {};
    const title = ((issue as { title?: string }).title ?? 'sentry alert').slice(0, 200);
    const url = (issue as { web_url?: string }).web_url ?? '';
    const sentryLevel = ((issue as { level?: string }).level ?? '').toLowerCase();
    const level = sentryLevel === 'fatal' || sentryLevel === 'error' ? 'p1' : 'info';
    await sendAlert({
      level,
      scope: 'platform',
      source: `sentry.${((body.data?.issue?.project?.slug ?? body.data?.event?.project?.slug) as string | undefined) ?? 'unknown'}`,
      title: `sentry: ${title}`,
      body: url || 'no issue url',
      context: { action: body.action, sentryLevel },
    });
    res.json({ ok: true });
  } catch (err) {
    // Express 4 does NOT forward async rejections to errorHandler; without
    // this the request hangs with no response until the client times out.
    next(err);
  }
});

router.post('/axiom', async (req, res, next) => {
  try {
    if (!requireToken(req, res)) return;
    // Axiom monitor webhook payload shape (per their notifier docs):
    //   { monitor: { name, type, ... }, match: { count, value, ... },
    //     description, url, ... }
    // We pull the monitor name as the title, description+count as the body,
    // and pass the dashboard url so the operator can drill in from Telegram.
    const body = axiomBodySchema.parse(req.body);
    const title = body.monitor?.name ?? 'axiom alert';
    const description = body.description ?? body.monitor?.description ?? '';
    const matchInfo =
      body.match?.count !== undefined
        ? `count=${body.match.count}`
        : body.match?.value !== undefined
          ? `value=${body.match.value}`
          : '';
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'axiom',
      title: `axiom: ${title}`,
      body: [description, matchInfo, body.url].filter(Boolean).join(' · ') || 'no description',
      context: { url: body.url, monitorType: body.monitor?.type, timestamp: body.timestamp },
    });
    res.json({ ok: true });
  } catch (err) {
    // Express 4 does NOT forward async rejections to errorHandler; without
    // this the request hangs with no response until the client times out.
    next(err);
  }
});

router.post('/posthog', async (req, res, next) => {
  try {
    if (!requireToken(req, res)) return;
    const body = posthogBodySchema.parse(req.body);
    const title = body.alert?.name ?? body.insight?.name ?? 'posthog alert';
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'posthog',
      title: `posthog: ${title}`,
      body: `insight ${body.insight?.short_id ?? '?'} fired`,
      context: { matchCount: Array.isArray(body.matches) ? body.matches.length : 0 },
    });
    res.json({ ok: true });
  } catch (err) {
    // Express 4 does NOT forward async rejections to errorHandler; without
    // this the request hangs with no response until the client times out.
    next(err);
  }
});

router.post('/railway', async (req, res, next) => {
  try {
    if (!requireToken(req, res)) return;
    // Railway webhook payload (per docs.railway.com/guides/webhooks):
    //   { type, timestamp, project: { id, name }, environment: { id, name },
    //     deployment: { id, creator, meta, status } }
    // Relevant `type` values for build-failure visibility:
    //   DEPLOY_FAILED, DEPLOY_CRASHED, DEPLOY_REMOVED, DEPLOY_BUILDING (info)
    // Silent build failures (P1-8 in 2026-05-22 audit) become loud Telegram
    // pings — the old container keeps serving the previous deploy while
    // routes added in the failed commit 404 silently otherwise.
    const body = railwayBodySchema.parse(req.body);
    const type = body.type ?? 'unknown';
    // P0 for crashes + failures, info for everything else (started / building /
    // succeeded). Filter at Railway's side too — only subscribe to FAILED +
    // CRASHED in the project's webhook config to avoid info noise.
    const level: 'p0' | 'p1' | 'info' =
      type === 'DEPLOY_FAILED' || type === 'DEPLOY_CRASHED'
        ? 'p0'
        : type === 'DEPLOY_REMOVED'
          ? 'p1'
          : 'info';
    const projectName = body.project?.name ?? 'ebda-api';
    const envName = body.environment?.name ?? 'production';
    const commitMsg = body.deployment?.meta?.commitMessage?.slice(0, 120) ?? '';
    const commitAuthor = body.deployment?.meta?.commitAuthor ?? '';
    await sendAlert({
      level,
      scope: 'platform',
      source: 'railway',
      title: `railway ${type.toLowerCase().replace('deploy_', '')}: ${projectName}/${envName}`,
      body: commitMsg
        ? `${commitMsg}${commitAuthor ? ` (${commitAuthor})` : ''}`
        : `deployment ${body.deployment?.id ?? '?'}`,
      context: {
        type,
        projectId: body.project?.id,
        deploymentId: body.deployment?.id,
        status: body.deployment?.status,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    // Express 4 does NOT forward async rejections to errorHandler; without
    // this the request hangs with no response until the client times out.
    next(err);
  }
});

router.post('/generic', async (req, res, next) => {
  try {
    if (!requireToken(req, res)) return;
    const body = genericBodySchema.parse(req.body);
    if (!body.title) {
      res.status(400).json({
        ok: false,
        success: false,
        error: { code: 'missing_title', message: 'Missing required field: title.' },
      });
      return;
    }
    await sendAlert({
      level: body.level === 'p0' || body.level === 'info' ? body.level : 'p1',
      scope: 'platform',
      source: body.source || 'external.generic',
      title: body.title.slice(0, 200),
      body: body.body ?? '',
    });
    res.json({ ok: true });
  } catch (err) {
    // Express 4 does NOT forward async rejections to errorHandler; without
    // this the request hangs with no response until the client times out.
    next(err);
  }
});

router.get('/healthcheck', (_req, res) => {
  res.json({ ok: true });
});

export default router;

logger.info(
  { tokenRequired: alertsBridgeConfigured() },
  'alert-webhooks routes mounted at /api/v1/webhooks/alerts'
);
