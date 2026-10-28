import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { writeFreeze } from '../write-freeze';

function run(method: string, path: string) {
  const next = vi.fn();
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const setHeader = vi.fn();
  writeFreeze({ method, path } as Request, { status, setHeader } as unknown as Response, next);
  return { next, status, json, setHeader };
}

describe('writeFreeze', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is a no-op unless WRITES_FROZEN is exactly "1"', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', '1 ']) {
      if (v === undefined) vi.stubEnv('WRITES_FROZEN', '');
      else vi.stubEnv('WRITES_FROZEN', v);
      const r = run('POST', '/api/v1/orders');
      expect(r.next, `value ${JSON.stringify(v)}`).toHaveBeenCalledTimes(1);
      expect(r.status).not.toHaveBeenCalled();
    }
  });

  it('answers 503 + Retry-After to every write while frozen', () => {
    vi.stubEnv('WRITES_FROZEN', '1');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = run(m, '/api/v1/carts');
      expect(r.next).not.toHaveBeenCalled();
      expect(r.status).toHaveBeenCalledWith(503);
      expect(r.setHeader).toHaveBeenCalledWith('Retry-After', '300');
      expect(r.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ code: 'READ_ONLY_WINDOW' }) })
      );
    }
  });

  it('keeps reads, health probes and the alert webhook open while frozen', () => {
    vi.stubEnv('WRITES_FROZEN', '1');
    for (const [m, p] of [
      ['GET', '/api/v1/products'],
      ['HEAD', '/api/v1/products'],
      ['OPTIONS', '/api/v1/carts'],
      ['POST', '/api/v1/alerts/webhooks/sentry'],
      ['GET', '/health'],
      ['POST', '/api/v1/health'],
    ]) {
      const r = run(m, p);
      expect(r.next, `${m} ${p}`).toHaveBeenCalledTimes(1);
    }
  });

  it('does not exempt look-alike paths', () => {
    vi.stubEnv('WRITES_FROZEN', '1');
    expect(run('POST', '/api/v1/healthy-orders').status).toHaveBeenCalledWith(503);
    expect(run('POST', '/api/v1/alerts/webhooksx').status).toHaveBeenCalledWith(503);
  });
});
