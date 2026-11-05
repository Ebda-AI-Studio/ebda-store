/**
 * Issue 2363 — `sms:failed` held real customer messages with no viewer, no
 * replay and no discard; `SmsQueueService.retryFailed` had no caller at all.
 * These are the super-admin routes behind `/sms-queue`, the twins of the
 * email-queue handlers: listed with the number MASKED and the text never
 * returned, replay and discard audited, super_admin only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  role: 'super_admin',
  auditLog: vi.fn(),
  redisUp: true,
  sms: {
    getFailedMessages: vi.fn(),
    getStats: vi.fn(),
    getCorruptEntries: vi.fn(),
    retryFailed: vi.fn(),
    discardCorrupt: vi.fn(),
  },
  email: {
    getFailedEmails: vi.fn(),
    getStats: vi.fn(),
    getCorruptEntries: vi.fn(),
  },
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: h.role };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: h.auditLog }));
vi.mock('@api/services/sms-queue.service', () => ({ smsQueue: h.sms }));
vi.mock('@api/services/email-queue.service', () => ({ emailQueue: h.email }));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: () => h.redisUp, getClient: () => null },
}));

// The router wraps every request in the acting user's tenant transaction (`userContext`); this
// file is about the handlers, so the wrapper is a pass-through (it has its own DB-backed coverage).
vi.mock('@api/middleware/tenant-context', () => ({
  userContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  platformUserContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// A super_admin request is wrapped in the named 'platform-operator' guard hatch (R-EBDA-003);
// there is no database here, so the hatch is a pass-through.
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  asPlatformOperator: (_userId: string, fn: () => unknown) => fn(),
}));

import adminRoutes from '@api/routes/admin.routes';
import { errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin', adminRoutes);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'super_admin';
  h.redisUp = true;
  h.auditLog.mockResolvedValue(undefined);
  h.sms.getFailedMessages.mockResolvedValue([
    {
      id: 'sms_1',
      storeId: 'store-1',
      event: 'order_shipped',
      recipientPhone: '+96512345678',
      messageText: 'Your order ORD-1 has shipped',
      attempts: 3,
      error: 'provider 500',
      createdAt: '2026-10-01T00:00:00Z',
    },
  ]);
  h.sms.getStats.mockResolvedValue({ pending: 2, failed: 1, corrupt: 0, processing: true });
  h.sms.getCorruptEntries.mockResolvedValue([]);
  h.sms.retryFailed.mockResolvedValue({ retried: 1, skipped: 0, kept: 0 });
  h.sms.discardCorrupt.mockResolvedValue(4);
});

describe('/admin/sms-queue (issue 2363)', () => {
  it('lists failed SMS with the number masked and the text never returned', async () => {
    const res = await request(app()).get('/admin/sms-queue/failed');
    expect(res.status).toBe(200);
    expect(res.body.data.stats).toEqual({ pending: 2, failed: 1, corrupt: 0 });
    const [m] = res.body.data.messages;
    expect(m.to).toBe('+965 ****5678');
    expect(JSON.stringify(res.body)).not.toContain('12345678');
    expect(JSON.stringify(res.body)).not.toContain('has shipped');
  });

  it('Redis down → stats are unknown (null), not zero', async () => {
    h.redisUp = false;
    const res = await request(app()).get('/admin/sms-queue/failed');
    expect(res.body.data.stats).toBeNull();
  });

  it('retry replays and writes an audit row', async () => {
    const res = await request(app()).post('/admin/sms-queue/failed/retry');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ retried: 1, skipped: 0, kept: 0 });
    expect(h.sms.retryFailed).toHaveBeenCalledTimes(1);
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sms_queue.retry_failed', resourceId: 'sms:failed' })
    );
  });

  it('discard drops the set-aside list and writes an audit row', async () => {
    const res = await request(app()).post('/admin/sms-queue/corrupt/discard');
    expect(res.body.data).toEqual({ discarded: 4 });
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sms_queue.discard_corrupt', details: { discarded: 4 } })
    );
  });

  it.each([
    ['get', '/admin/sms-queue/failed'],
    ['post', '/admin/sms-queue/failed/retry'],
    ['post', '/admin/sms-queue/corrupt/discard'],
  ] as const)('%s %s refuses a store_admin', async (method, url) => {
    h.role = 'store_admin';
    const res = await request(app())[method](url);
    expect(res.status).toBe(403);
    expect(h.sms.retryFailed).not.toHaveBeenCalled();
    expect(h.sms.discardCorrupt).not.toHaveBeenCalled();
  });
});

// Issue 2374: a dead-lettered email that parses but has no `options` used to
// TypeError in the list mapper and 500 the WHOLE endpoint — the page then read
// "No failed emails" with Retry all disabled. The reader now filters such rows
// (email-queue.test.ts); this is the second net: one bad row never 500s.
describe('/admin/email-queue/failed — a shapeless row never 500s the list (issue 2374)', () => {
  it('lists the good row and survives the shapeless one', async () => {
    h.email.getFailedEmails.mockResolvedValue([
      { id: 'bad', attempts: 3, createdAt: '2026-10-01T00:00:00Z' },
      {
        id: 'good',
        storeId: 'store-1',
        options: { to: 'buyer@example.com', subject: 'Order ORD-1', html: '<p/>' },
        attempts: 3,
        createdAt: '2026-10-01T00:00:00Z',
      },
    ]);
    h.email.getStats.mockResolvedValue({ pending: 0, failed: 2, corrupt: 0, processing: false });
    h.email.getCorruptEntries.mockResolvedValue([]);

    const res = await request(app()).get('/admin/email-queue/failed');

    expect(res.status).toBe(200);
    expect(res.body.data.emails.map((e: { id: string }) => e.id)).toEqual(['bad', 'good']);
    expect(res.body.data.emails[1].to).toEqual(['b***@example.com']);
    expect(res.body.data.emails[0]).toMatchObject({ to: [null], subject: '', storeId: null });
  });
});
