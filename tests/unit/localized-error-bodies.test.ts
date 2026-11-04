/**
 * Contract T1 -> admin `ERROR_AR` (BE:E-2/E-3/E-7): RATE_LIMITED, VALIDATION_ERROR and the Multer text carry
 * `details.messageAr` + `details.messageEn`, so the admin shows Arabic without a per-call-site map. `error.code` is always there.
 * Plus the Server-Timing split (BE:E-1): auth / identity / db-wait / handler.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod/v3';

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { localizeRateLimited, RATE_LIMITED_MESSAGE } = await import('@api/lib/localized-error');
const { errorHandler } = await import('@api/middleware/error-handler');
const { serverTiming, recordTiming, formatServerTiming } = await import('@api/lib/request-timing');

const ARABIC = /[؀-ۿ]/;
const NO_ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;

function app(setup: (a: express.Express) => void) {
  const a = express();
  a.use(express.json());
  setup(a);
  a.use(errorHandler);
  return a;
}

describe('RATE_LIMITED bodies', () => {
  it('any limiter body that answers RATE_LIMITED gets the bilingual details', async () => {
    const res = await request(
      app(a => {
        a.use(localizeRateLimited);
        a.get('/x', (_q, r) => {
          r.status(429).json({
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
          });
        });
      })
    ).get('/x');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.message).toBe('Too many requests, please try again later.');
    expect(res.body.error.details).toEqual(RATE_LIMITED_MESSAGE);
    expect(res.body.error.details.messageAr).toMatch(ARABIC);
    expect(res.body.error.details.messageAr).not.toMatch(NO_ARABIC_INDIC_DIGITS);
  });

  it('leaves other bodies, and a body that already has messageAr, alone', async () => {
    const res = await request(
      app(a => {
        a.use(localizeRateLimited);
        a.get('/ok', (_q, r) => void r.json({ success: true, data: { code: 'RATE_LIMITED' } }));
        a.get('/own', (_q, r) => {
          r.status(429).json({
            success: false,
            error: {
              code: 'RATE_LIMITED',
              message: 'm',
              details: { messageAr: 'x', messageEn: 'y' },
            },
          });
        });
      })
    ).get('/own');
    expect(res.body.error.details).toEqual({ messageAr: 'x', messageEn: 'y' });
    const ok = await request(
      app(a => {
        a.use(localizeRateLimited);
        a.get('/ok', (_q, r) => void r.json({ success: true, data: { code: 'RATE_LIMITED' } }));
      })
    ).get('/ok');
    expect(ok.body).toEqual({ success: true, data: { code: 'RATE_LIMITED' } });
  });
});

describe('VALIDATION_ERROR', () => {
  it('keeps the field map and adds the bilingual sentence', async () => {
    const res = await request(
      app(a => {
        a.post('/x', (req, _r) => {
          z.object({ name: z.string().min(2) }).parse(req.body);
        });
      })
    )
      .post('/x')
      .send({ name: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Invalid request data');
    expect(res.body.error.details.name).toEqual([expect.any(String)]);
    expect(res.body.error.details.messageAr).toMatch(ARABIC);
    expect(res.body.error.details.messageEn).toEqual(expect.any(String));
  });
});

describe('Multer text (E-7)', () => {
  it.each([
    ['LIMIT_FILE_SIZE', 413, 'FILE_TOO_LARGE'],
    ['LIMIT_UNEXPECTED_FILE', 400, 'LIMIT_UNEXPECTED_FILE'],
    ['LIMIT_WEIRD', 400, 'LIMIT_WEIRD'],
  ])("%s is a bilingual sentence, never multer's raw text", async (mcode, status, code) => {
    const res = await request(
      app(a => {
        a.post('/up', () => {
          throw Object.assign(new Error('Unexpected field "secret_internal_name"'), {
            name: 'MulterError',
            code: mcode,
          });
        });
      })
    ).post('/up');
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toContain('secret_internal_name');
    expect(res.body.error.details.messageAr).toMatch(ARABIC);
    expect(res.body.error.details.messageEn).toEqual(expect.any(String));
  });
});

describe('Server-Timing', () => {
  it('formats auth / identity / db-wait and the handler remainder', () => {
    const t = { start: 100, ms: { auth: 20, identity: 15, 'db-wait': 30 } };
    expect(formatServerTiming(t, 200)).toBe(
      'auth;dur=20.0, identity;dur=15.0, db-wait;dur=30.0, handler;dur=50.0'
    );
  });

  it('is on the response next to an existing request-tx entry', async () => {
    const res = await request(
      app(a => {
        a.use(serverTiming);
        a.get('/x', (req, r) => {
          recordTiming(req, 'auth', 3);
          recordTiming(req, 'identity', 2);
          recordTiming(req, 'db-wait', 1);
          r.setHeader('Server-Timing', 'request-tx;desc="commit";dur=4');
          r.json({ ok: true });
        });
      })
    ).get('/x');
    const header = String(res.headers['server-timing']);
    expect(header).toContain('request-tx;desc="commit";dur=4');
    for (const name of ['auth', 'identity', 'db-wait', 'handler'])
      expect(header).toContain(`${name};dur=`);
  });
});
