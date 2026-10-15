/**
 * The `legal-notice-send` Inngest function and its batch step (Ruling LEGAL-4, amendment A4),
 * without a database: the step loop, the step cap (`fail-leftover`), `onFailure`, and the
 * order "wait for a send slot WITH a budget, THEN claim queued -> sending" in sendNextBatch.
 * The real-Postgres twin (RLS, dedupe, retry) is tests/integration/legal-notice-fanout.test.ts.
 * Pattern: tests/unit/campaign-send-job.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';

type Row = {
  userId: string;
  docKey: string;
  version: string;
  status: string;
  error: string | null;
};

const h = vi.hoisted(() => ({
  captured: { config: null as any, handler: null as any },
  rows: [] as Array<{
    userId: string;
    docKey: string;
    version: string;
    status: string;
    error: string | null;
  }>,
  calls: [] as string[],
  owners: [] as string[],
  sendRow: true,
  awaitCampaignSendSlot: vi.fn(async (_maxWaitMs?: number) => true),
  sendLegalNoticeEmail: vi.fn(async (_d: { email: string }) => undefined),
  sendAlert: vi.fn(async () => 'sent'),
}));

const match = (r: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v);

vi.mock('@ebda/database', () => ({
  asPlatformOperator: (_op: string, fn: () => unknown) => fn(),
  withUser: (_u: string, fn: (tx: unknown) => unknown) => fn({}),
  prisma: {
    legalNoticeSend: {
      findUnique: async () => (h.sendRow ? { id: 'send-1' } : null),
      update: async () => ({}),
    },
    store: { findMany: async () => h.owners.map(ownerId => ({ ownerId })) },
    legalNoticeDelivery: {
      createMany: async ({
        data,
      }: {
        data: Array<{ userId: string; docKey: string; version: string }>;
      }) => {
        let count = 0;
        for (const d of data) {
          if (
            h.rows.some(
              r => r.userId === d.userId && r.docKey === d.docKey && r.version === d.version
            )
          )
            continue;
          h.rows.push({ ...d, status: 'queued', error: null });
          count++;
        }
        return { count };
      },
      findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
        h.rows
          .filter(r => match(r, where))
          .sort((a, b) => a.userId.localeCompare(b.userId))
          .slice(0, take)
          .map(r => ({ userId: r.userId })),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Row>;
      }) => {
        const hit = h.rows.filter(r => match(r, where));
        for (const r of hit) {
          Object.assign(r, data);
          h.calls.push(`${data.status}:${r.userId}`);
        }
        return { count: hit.length };
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        h.rows.filter(r => match(r, where)).length,
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        [...where.id.in].sort().map(id => ({ id })),
      findUnique: async ({ where }: { where: { id: string } }) => ({
        email: `${where.id}@test.local`,
        firstName: where.id,
      }),
    },
  },
}));
vi.mock('@api/lib/campaign-send-pacer', () => ({
  awaitCampaignSendSlot: async (ms?: number) => {
    h.calls.push('slot');
    return h.awaitCampaignSendSlot(ms);
  },
}));
vi.mock('@api/services/platform-mailer', () => ({
  sendLegalNoticeEmail: async (d: { email: string }) => {
    h.calls.push(`mail:${d.email}`);
    return h.sendLegalNoticeEmail(d);
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: (cfg: unknown, handler: unknown) => {
      h.captured.config = cfg;
      h.captured.handler = handler;
      return { id: 'legal-notice-send' };
    },
  },
}));

import * as service from '@api/services/legal-notice.service';
import { runLegalNoticeSend } from '@api/lib/inngest/functions/legal-notice-send';

const V = '99.0';
const FIXTURE: LegalPolicies = {
  ...LEGAL_POLICIES,
  terms: {
    history: [
      ...LEGAL_POLICIES.terms.history,
      {
        version: V,
        publishedAt: '2026-10-20',
        effectiveAt: '2026-11-20',
        material: true,
        feeChange: true,
        summary: { ar: 'تغيير تجريبي.', en: 'Test change.' },
      },
    ],
  },
};
const EVENT = { data: { docKey: 'terms', version: V, sentBy: 'op-1' } };

function makeStep(ids: string[] = []) {
  return {
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      ids.push(id);
      const v = await fn();
      return (v === undefined ? null : JSON.parse(JSON.stringify(v))) as T;
    },
  };
}
const seed = (...users: string[]) => {
  for (const userId of users)
    h.rows.push({ userId, docKey: 'terms', version: V, status: 'queued', error: null });
};

beforeEach(() => {
  h.rows.length = 0;
  h.calls.length = 0;
  h.awaitCampaignSendSlot.mockReset().mockImplementation(async () => true);
  h.sendLegalNoticeEmail.mockReset().mockImplementation(async () => undefined);
  h.sendAlert.mockClear();
  h.owners.length = 0;
  h.sendRow = true;
  service.__setLegalPoliciesForTests(FIXTURE);
});

describe('legal-notice-send function config', () => {
  it('is triggered only by legal/notice.send-requested, one run at a time, retried', () => {
    expect(h.captured.config.id).toBe('legal-notice-send');
    expect(h.captured.config.triggers).toEqual([{ event: 'legal/notice.send-requested' }]);
    expect(h.captured.config.concurrency).toEqual({ limit: 1 });
    expect(h.captured.config.retries).toBeGreaterThan(0);
  });
});

describe('sendNextBatch (A4: slot with a budget BEFORE the claim)', () => {
  it('waits for a slot before claiming each row, then mails it', async () => {
    seed('u1', 'u2');
    const r = await service.sendNextBatch('op-1', 'terms', V);
    expect(r).toEqual({ sent: 2, failed: 0, remaining: 0, deferred: false });
    expect(h.calls).toEqual([
      'slot',
      'sending:u1',
      'mail:u1@test.local',
      'sent:u1',
      'slot',
      'sending:u2',
      'mail:u2@test.local',
      'sent:u2',
    ]);
  });

  it('passes a finite remaining budget to the pacer, never an unbounded wait', async () => {
    seed('u1');
    await service.sendNextBatch('op-1', 'terms', V, 20, 5_000);
    const budget = h.awaitCampaignSendSlot.mock.calls[0][0]!;
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(5_000);
  });

  it('no slot inside the budget: ends the step without claiming, the row stays queued', async () => {
    seed('u1', 'u2');
    h.awaitCampaignSendSlot.mockImplementation(async () => false);
    const r = await service.sendNextBatch('op-1', 'terms', V);
    expect(r).toEqual({ sent: 0, failed: 0, remaining: 2, deferred: true });
    expect(h.calls).toEqual(['slot']);
    expect(h.rows.map(x => x.status)).toEqual(['queued', 'queued']);
    expect(h.sendLegalNoticeEmail).not.toHaveBeenCalled();
  });

  it('a spent budget defers without even asking the pacer', async () => {
    seed('u1');
    const r = await service.sendNextBatch('op-1', 'terms', V, 20, 0);
    expect(r.deferred).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.rows[0].status).toBe('queued');
  });

  it('a send error marks that row failed with the message and the batch goes on', async () => {
    seed('u1', 'u2');
    h.sendLegalNoticeEmail.mockImplementation(async d => {
      if (d.email === 'u1@test.local') throw new Error('Resend send failed: boom');
    });
    const r = await service.sendNextBatch('op-1', 'terms', V);
    expect(r).toMatchObject({ sent: 1, failed: 1, remaining: 0 });
    expect(h.rows.find(x => x.userId === 'u1')).toMatchObject({
      status: 'failed',
      error: 'Resend send failed: boom',
    });
    expect(h.rows.find(x => x.userId === 'u2')?.status).toBe('sent');
  });

  it('never re-sends a row already in sending (a crash after the mail went out)', async () => {
    seed('u1');
    h.rows[0].status = 'sending';
    const r = await service.sendNextBatch('op-1', 'terms', V);
    expect(r).toMatchObject({ sent: 0, remaining: 0 });
    expect(h.sendLegalNoticeEmail).not.toHaveBeenCalled();
  });
});

describe('runLegalNoticeSend loop', () => {
  it('a deferred step is followed by another step that finishes the rest (no fail-leftover)', async () => {
    h.owners.push('u1', 'u2', 'u1');
    h.awaitCampaignSendSlot.mockImplementationOnce(async () => false);
    const ids: string[] = [];
    const r = await runLegalNoticeSend({ event: EVENT, step: makeStep(ids) });
    expect(r).toEqual({ recipientCount: 2, sent: 2, failed: 0, stranded: 0 });
    expect(ids).toEqual(['materialize', 'batch-0', 'batch-1']);
  });

  it('fail-leftover: at the step cap every still-queued row is failed and a P1 raised', async () => {
    h.owners.push('u1', 'u2', 'u3');
    h.awaitCampaignSendSlot.mockImplementation(async () => false);
    const ids: string[] = [];
    const r = await runLegalNoticeSend({ event: EVENT, step: makeStep(ids) });
    expect(ids.filter(i => i.startsWith('batch-'))).toHaveLength(
      service.LEGAL_NOTICE_MAX_BATCH_STEPS
    );
    expect(ids.slice(-2)).toEqual(['fail-leftover', 'alert-stranded']);
    expect(r).toEqual({ recipientCount: 3, sent: 0, failed: 0, stranded: 3 });
    expect(h.rows.every(x => x.status === 'failed' && x.error === 'SEND_WINDOW_EXHAUSTED')).toBe(
      true
    );
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    // Steps per run stay under Inngest's 1,000-step cap.
    expect(ids.length).toBeLessThan(1000);
  });

  it('skips without sending when the send row is gone', async () => {
    h.sendRow = false;
    h.owners.push('u1');
    const r = await runLegalNoticeSend({ event: EVENT, step: makeStep() });
    expect(r).toEqual({ skipped: 'SEND_ROW_MISSING' });
    expect(h.rows).toEqual([]);
    expect(h.sendLegalNoticeEmail).not.toHaveBeenCalled();
  });

  it('skips an event without docKey/version/sentBy', async () => {
    const r = await runLegalNoticeSend({ event: { data: { docKey: 'terms' } }, step: makeStep() });
    expect(r).toEqual({ skipped: 'missing-data' });
  });
});

describe('onFailure', () => {
  it('marks every still-queued row failed (SEND_JOB_FAILED) and leaves finished rows alone', async () => {
    seed('u1', 'u2', 'u3');
    h.rows[0].status = 'sent';
    h.rows[1].status = 'sending';
    await h.captured.config.onFailure({ event: { data: { event: EVENT } } });
    expect(h.rows.map(x => [x.status, x.error])).toEqual([
      ['sent', null],
      ['sending', null],
      ['failed', 'SEND_JOB_FAILED'],
    ]);
  });

  it('does nothing for an event without ids', async () => {
    seed('u1');
    await h.captured.config.onFailure({ event: { data: { event: { data: {} } } } });
    expect(h.rows[0].status).toBe('queued');
  });
});
