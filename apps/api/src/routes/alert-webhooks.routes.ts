import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import logger from '../lib/logger';
import { sendAlert } from '../services/alerts.service';

const router = Router();

const ALERTS_TOKEN = process.env.ALERTS_WEBHOOK_TOKEN;

// CLAUDE.md rule 12: a missing token in production means the bridge accepts
// spoofed alerts from any IP — a single curl floods Telegram. Warn loudly at
// boot so the misconfiguration is visible in the Railway logs instead of
// silently allowed. Dev / preview without the env var still works (no token
// required), same convenience the original `!ALERTS_TOKEN -> allow` gave.
if (!ALERTS_TOKEN && process.env.NODE_ENV === 'production') {
  logger.error(
    { rule: 'CLAUDE.md#12', endpoint: '/api/v1/alerts/webhooks/*' },
    'ALERTS_WEBHOOK_TOKEN is unset in production — webhook bridge accepts any payload. Set the env var on Railway immediately.'
  );
}

function requireToken(req: Request, res: Response): boolean {
  if (!ALERTS_TOKEN) return true;
  const token = (req.query.token as string) || req.header('x-alerts-token') || '';
  if (!token || token.length !== ALERTS_TOKEN.length) {
    res.status(401).json({
      ok: false,
      success: false,
      error: { code: 'invalid_token', message: 'Missing or invalid alerts webhook token.' },
    });
    return false;
  }
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ALERTS_TOKEN))) {
    res.status(401).json({
      ok: false,
      success: false,
      error: { code: 'invalid_token', message: 'Missing or invalid alerts webhook token.' },
    });
    return false;
  }
  return true;
}

router.post('/sentry', async (req, res, next) => {
  try {
    if (!requireToken(req, res)) return;
    const body = (req.body ?? {}) as {
      action?: string;
      data?: {
        issue?: { title?: string; web_url?: string; level?: string; project?: { slug?: string } };
      };
      event?: { title?: string; web_url?: string; level?: string; environment?: string };
    };
    const issue = body.data?.issue ?? body.event ?? {};
    const title = ((issue as { title?: string }).title ?? 'sentry alert').slice(0, 200);
    const url = (issue as { web_url?: string }).web_url ?? '';
    const sentryLevel = ((issue as { level?: string }).level ?? '').toLowerCase();
    const level = sentryLevel === 'fatal' || sentryLevel === 'error' ? 'p1' : 'info';
    await sendAlert({
      level,
      scope: 'platform',
      source: `sentry.${(body.data?.issue?.project?.slug as string | undefined) ?? 'unknown'}`,
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
    const body = (req.body ?? {}) as {
      monitor?: { name?: string; type?: string; description?: string };
      match?: { count?: number; value?: number };
      description?: string;
      url?: string;
      timestamp?: string;
    };
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
    const body = (req.body ?? {}) as {
      insight?: { name?: string; short_id?: string };
      alert?: { name?: string };
      matches?: unknown[];
    };
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
    const body = (req.body ?? {}) as {
      type?: string;
      timestamp?: string;
      project?: { id?: string; name?: string };
      environment?: { id?: string; name?: string };
      deployment?: {
        id?: string;
        status?: string;
        creator?: { name?: string };
        meta?: { commitMessage?: string; commitAuthor?: string };
      };
    };
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
    const projectName = body.project?.name ?? 'force-api';
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
    const body = (req.body ?? {}) as {
      title?: string;
      body?: string;
      level?: 'p0' | 'p1' | 'info';
      source?: string;
    };
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
  { tokenRequired: !!ALERTS_TOKEN },
  'alert-webhooks routes mounted at /api/v1/webhooks/alerts'
);
