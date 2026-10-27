import { describe, expect, it, vi } from 'vitest';
import { parseDsn, probeSentry } from '@api/lib/jobs/sentry-probe';

const DSN = 'https://abc123key@o99.ingest.de.sentry.io/4512212920565840';

describe('sentry probe', () => {
  it('parses key, host and project id from a DSN', () => {
    expect(parseDsn(DSN)).toEqual({
      key: 'abc123key',
      host: 'o99.ingest.de.sentry.io',
      project: '4512212920565840',
      scheme: 'https',
    });
    expect(parseDsn('not a dsn')).toBeNull();
    expect(parseDsn('https://host/123')).toBeNull(); // no key
  });

  it('posts an envelope to the ingest endpoint and reports status, host and project, never the key', async () => {
    const f = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    const r = await probeSentry(DSN, f as never);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://o99.ingest.de.sentry.io/api/4512212920565840/envelope/');
    expect(init.headers['x-sentry-auth']).toContain('sentry_key=abc123key');
    expect(r).toMatchObject({
      status: 200,
      project: '4512212920565840',
      host: 'o99.ingest.de.sentry.io',
    });
    expect(JSON.stringify(r)).not.toContain('abc123key');
  });

  it('records a refused or failing transport honestly', async () => {
    const refused = await probeSentry(
      DSN,
      (async () => new Response('forbidden', { status: 403 })) as never
    );
    expect(refused).toMatchObject({ status: 403, head: 'forbidden' });
    const down = await probeSentry(DSN, (async () => {
      throw new Error('network down');
    }) as never);
    expect(down).toMatchObject({ status: null, project: '4512212920565840' });
    expect(await probeSentry(undefined)).toEqual({ error: 'no usable SENTRY_DSN in this context' });
  });

  it('can send the real failure as an error event with tags (the direct fallback)', async () => {
    const f = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    const r = await probeSentry(DSN, f as never, {
      message: 'job failed: x',
      errorName: 'Error',
      errorMessage: 'boom',
      tags: { job: 'x', group: '4-ai' },
      extra: { instanceId: 'i1', triggeringEvent: 'a/b' },
    });
    const body = (f.mock.calls[0] as unknown as [string, { body: string }])[1].body.split('\n');
    const ev = JSON.parse(body[2]);
    expect(ev).toMatchObject({
      level: 'error',
      message: 'job failed: x',
      tags: { job: 'x', group: '4-ai' },
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    });
    expect(r).toMatchObject({ status: 200 });
  });
});
