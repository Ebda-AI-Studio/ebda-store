/** The pino-shaped console JSON logger used on Workers (apps/api/src/lib/console-logger.ts). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createConsoleLogger } from '@api/lib/console-logger';

afterEach(() => vi.restoreAllMocks());

function capture() {
  const lines: Array<{ sink: string; json: Record<string, any> }> = [];
  for (const sink of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, sink).mockImplementation((l: string) => {
      lines.push({ sink, json: JSON.parse(l) });
    });
  }
  return lines;
}

describe('createConsoleLogger', () => {
  it('writes one JSON line per call: level, time, base fields, msg', () => {
    const out = capture();
    createConsoleLogger({ base: { env: 'production' } }).info('hello');
    expect(out).toHaveLength(1);
    expect(out[0].json).toMatchObject({ level: 'info', env: 'production', msg: 'hello' });
    expect(new Date(out[0].json.time).toString()).not.toBe('Invalid Date');
  });

  it('pino call shape: (object, message)', () => {
    const out = capture();
    createConsoleLogger().warn({ storeId: 's1', count: 3 }, 'something');
    expect(out[0].sink).toBe('warn');
    expect(out[0].json).toMatchObject({ level: 'warn', storeId: 's1', count: 3, msg: 'something' });
  });

  it('errors go to console.error, and an Error becomes {type, message, stack}', () => {
    const out = capture();
    createConsoleLogger().error({ err: new TypeError('boom') }, 'failed');
    expect(out[0].sink).toBe('error');
    expect(out[0].json.err).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect(out[0].json.err.stack).toContain('boom');
  });

  it('a bare Error as the first argument is serialised under err, message defaults to its own', () => {
    const out = capture();
    createConsoleLogger().error(new Error('kaput'));
    expect(out[0].json.err.message).toBe('kaput');
    expect(out[0].json.msg).toBe('kaput');
  });

  it('honours the level threshold', () => {
    const out = capture();
    const log = createConsoleLogger({ level: 'warn' });
    log.debug('no');
    log.info('no');
    log.warn('yes');
    expect(out.map(o => o.json.msg)).toEqual(['yes']);
    expect(log.isLevelEnabled('info')).toBe(false);
    expect(log.isLevelEnabled('error')).toBe(true);
  });

  it('redacts the same secrets the pino logger does, at any depth', () => {
    const out = capture();
    createConsoleLogger().info(
      {
        req: {
          headers: { authorization: 'Bearer abc', cookie: 'c=1' },
          body: { password: 'hunter2', note: 'ok' },
        },
        accessToken: 't',
      },
      'x'
    );
    const j = out[0].json;
    expect(j.req.headers.authorization).toBe('[Redacted]');
    expect(j.req.headers.cookie).toBe('[Redacted]');
    expect(j.req.body.password).toBe('[Redacted]');
    expect(j.req.body.note).toBe('ok');
    expect(j.accessToken).toBe('[Redacted]');
    expect(JSON.stringify(j)).not.toContain('hunter2');
  });

  it('child() adds bindings and keeps the level', () => {
    const out = capture();
    const child = createConsoleLogger({ level: 'info' }).child({ requestId: 'r1' });
    child.info('a');
    child.debug('hidden');
    expect(out).toHaveLength(1);
    expect(out[0].json.requestId).toBe('r1');
  });

  it('survives cycles-free deep objects and bigint', () => {
    const out = capture();
    createConsoleLogger().info(
      { n: 10n, deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } },
      'deep'
    );
    expect(out[0].json.n).toBe('10');
    expect(JSON.stringify(out[0].json)).toContain('[Truncated]');
  });
});
