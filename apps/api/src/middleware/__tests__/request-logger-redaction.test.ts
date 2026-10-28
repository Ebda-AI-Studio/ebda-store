import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  default: { info, warn: vi.fn(), error: vi.fn() },
}));

import { requestLogger } from '../request-logger';

describe('requestLogger redacts path secrets (SEC-8)', () => {
  it('never logs the Bosta webhook token', () => {
    const TOKEN = ['not', 'a', 'secret', '0123456789', '0123456789'].join('-');
    const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as Response;
    const req = {
      method: 'POST',
      path: `/api/v1/webhooks/shipping/bosta/0f8fad5b-d9cb-469f-a165-70867728950e/${TOKEN}`,
      headers: {},
      params: {},
    } as unknown as Request;
    requestLogger(req, res, vi.fn() as unknown as NextFunction);
    res.emit('finish');
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('[Filtered]');
  });
});
