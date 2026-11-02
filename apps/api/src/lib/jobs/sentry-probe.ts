/**
 * When Sentry's flush does not finish, say WHY: POST one minimal event envelope straight to the DSN's
 * ingest endpoint and report the HTTP status. Returns what is safe to store in a step output: the
 * ingest host, the project id (the DSN path, not a secret), the status and a short response head.
 * The key and the full DSN are never returned or logged.
 */
import { timedFetch } from '../fetch-with-timeout';

export interface SentryProbeResult {
  host: string;
  project: string;
  status: number | null;
  head: string;
  eventId: string | null;
}

export function parseDsn(
  dsn: string
): { key: string; host: string; project: string; scheme: string } | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+/, '').split('/').pop() ?? '';
    if (!u.username || !project) return null;
    return { key: u.username, host: u.host, project, scheme: u.protocol.replace(':', '') };
  } catch {
    return null;
  }
}

/**
 * The real failure as a Sentry event, for when the SDK client is not active in the step (its flush
 * returns false and the captured event never leaves): same endpoint, but a proper error event.
 */
export interface DirectSentryEvent {
  message: string;
  errorName: string;
  errorMessage: string;
  tags: Record<string, string>;
  extra: Record<string, string>;
  environment?: string;
  release?: string;
}

export async function probeSentry(
  dsn: string | undefined,
  fetchImpl: typeof fetch = timedFetch('sentry.probe'),
  real?: DirectSentryEvent
): Promise<SentryProbeResult | { error: string }> {
  const p = dsn ? parseDsn(dsn) : null;
  if (!p) return { error: 'no usable SENTRY_DSN in this context' };
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const body =
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }) +
    '\n' +
    JSON.stringify({ type: 'event' }) +
    '\n' +
    JSON.stringify(
      real
        ? {
            event_id: eventId,
            level: 'error',
            message: real.message,
            exception: { values: [{ type: real.errorName, value: real.errorMessage }] },
            tags: real.tags,
            extra: real.extra,
            environment: real.environment,
            release: real.release,
            platform: 'javascript',
            timestamp: Date.now() / 1000,
          }
        : {
            event_id: eventId,
            level: 'info',
            message: 'ebda job failure: sentry transport probe',
            platform: 'javascript',
            timestamp: Date.now() / 1000,
          }
    );
  try {
    const res = await fetchImpl(`${p.scheme}://${p.host}/api/${p.project}/envelope/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_client=ebda-probe/1, sentry_key=${p.key}`,
      },
      body,
      signal: AbortSignal.timeout(4000),
    });
    return {
      host: p.host,
      project: p.project,
      status: res.status,
      head: (await res.text().catch(() => '')).slice(0, 120),
      eventId,
    };
  } catch (err) {
    return {
      host: p.host,
      project: p.project,
      status: null,
      head: String(err).slice(0, 120),
      eventId: null,
    };
  }
}
