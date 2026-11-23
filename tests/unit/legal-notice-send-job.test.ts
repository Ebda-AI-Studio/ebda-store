/**
 * The `legal-notice-send` Inngest function and its batch step (Ruling LEGAL-4, amendment A4),
 * without a database: the step loop, the step cap (`fail-leftover`), `onFailure`, and the
 * order "wait for a send slot WITH a budget, THEN claim queued -> sending" in sendNextBatch.
 * The platform-D1 twin (dedupe, retry, operator check) is tests/unit/legal-notice-fanout-on-d1.test.ts.
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
  recipientCount: null as number | null,
  mailerReady: true,
  users: {} as Record<string, { deletedAt: Date | null; role: string } | null>,
  operatorOk: true,
  awaitCampaignSendSlot: vi.fn(async (_maxWaitMs?: number) => true),
  sendLegalNoticeEmail: vi.fn(async (_d: { email: string }) => undefined),
  sendAlert: vi.fn(async () => 'sent'),
}));

const match = (r: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v);

vi.mock('@ebda/database', () => ({
  asPlatformOperator: (_op: string, fn: () => unknown) => {
    if (!h.operatorOk)
      throw new Error('asPlatformOperator: the acting user is not an active super_admin');
    return fn();
  },
  withUser: (_u: string, fn: (tx: unknown) => unknown) => fn({}),
  prisma: {
    // Tagged template: the first interpolated value is the send id the run is pinned to.
    $queryRaw: async (_strings: TemplateStringsArray, sendId: string) =>
      h.sendRow && sendId === 'send-1'
        ? [{ id: 'send-1', doc_key: 'terms', version: '99.0', recipient_count: h.recipientCount }]
        : [],
    legalNoticeSend: {
      findUnique: async () => (h.sendRow ? { id: 'send-1' } : null),
      findFirst: async ({ where }: { where: { id: string } }) =>
        h.sendRow && where.id === 'send-1' ? { id: 'send-1' } : null,
      update: async ({ data }: { data: { recipientCount: number } }) => {
        h.recipientCount = data.recipientCount;
        return {};
      },
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
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = h.users[where.id];
        if (u === null) return null;
        return {
          email: `${where.id}@test.local`,
          firstName: where.id,
          deletedAt: u?.deletedAt ?? null,
          role: u?.role ?? 'store_admin',
        };
      },
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
  legalNoticeMailerReady: () => h.mailerReady,
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
import {
  onLegalNoticeSendFailure,
  runLegalNoticeSend,
} from '@api/lib/inngest/functions/legal-notice-send';

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
const EVENT = { data: { sendId: 'send-1', docKey: 'terms', version: V, sentBy: 'op-1' } };

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
  h.recipientCount = null;
  h.mailerReady = true;
  h.operatorOk = true;
  for (const k of Object.keys(h.users)) delete h.users[k];
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

  it.each([
    ['a request timeout', new Error('Resend send failed: request timed out')],
    ['a socket timeout code', Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' })],
    [
      'an aborted request',
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    ],
    ['a dropped connection', new Error('read ECONNRESET')],
  ])('%s is recorded as TIMEOUT_UNKNOWN (the mail may have been delivered)', async (_l, err) => {
    seed('u1');
    h.sendLegalNoticeEmail.mockImplementation(async () => {
      throw err;
    });
    const r = await service.sendNextBatch('op-1', 'terms', V);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(h.rows[0]).toMatchObject({ status: 'failed', error: 'TIMEOUT_UNKNOWN' });
  });

  it('an ordinary provider rejection keeps its scrubbed message, not TIMEOUT_UNKNOWN', () => {
    expect(service.isUnknownOutcomeError(new Error('Resend send failed: invalid to address'))).toBe(
      false
    );
    expect(service.isUnknownOutcomeError(new Error('Resend send failed: rate limited (429)'))).toBe(
      false
    );
    expect(service.isUnknownOutcomeError('timeout')).toBe(true);
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
    expect(ids).toEqual(['materialize', 'preflight', 'batch-0', 'batch-1']);
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

  it('skips an event without sendId/docKey/version/sentBy', async () => {
    const r = await runLegalNoticeSend({ event: { data: { docKey: 'terms' } }, step: makeStep() });
    expect(r).toEqual({ skipped: 'missing-data' });
    const noId = await runLegalNoticeSend({
      event: { data: { docKey: 'terms', version: V, sentBy: 'op-1' } },
      step: makeStep(),
    });
    expect(noId).toEqual({ skipped: 'missing-data' });
  });

  it('M1: a run whose sendId is not the current send row adopts nothing', async () => {
    h.owners.push('u1');
    const r = await runLegalNoticeSend({
      event: { data: { ...EVENT.data, sendId: 'send-OLD' } },
      step: makeStep(),
    });
    expect(r).toEqual({ skipped: 'SEND_ROW_MISSING' });
    expect(h.rows).toEqual([]);
  });

  it('I5: recipients already materialised (Resume) -> nothing inserted, only queued rows mailed', async () => {
    h.recipientCount = 2;
    seed('u1');
    h.rows.push({ userId: 'u2', docKey: 'terms', version: V, status: 'sent', error: null });
    h.owners.push('u1', 'u2', 'u3'); // u3 is a NEW owner since the send: not added on resume
    const r = await runLegalNoticeSend({ event: EVENT, step: makeStep() });
    expect(r).toEqual({ recipientCount: 2, sent: 1, failed: 0, stranded: 0 });
    expect(h.rows.map(x => x.userId)).toEqual(['u1', 'u2']);
    expect(h.sendLegalNoticeEmail).toHaveBeenCalledTimes(1);
  });

  it('I2: mailer not configured -> checked ONCE, every queued row failed, P1, no pacer slot', async () => {
    h.mailerReady = false;
    h.owners.push('u1', 'u2');
    const ids: string[] = [];
    const r = await runLegalNoticeSend({ event: EVENT, step: makeStep(ids) });
    expect(ids).toEqual(['materialize', 'preflight']);
    expect(r).toMatchObject({ sent: 0, failed: 2, skipped: 'MAIL_NOT_CONFIGURED' });
    expect(h.rows.map(x => [x.status, x.error])).toEqual([
      ['failed', 'MAIL_NOT_CONFIGURED'],
      ['failed', 'MAIL_NOT_CONFIGURED'],
    ]);
    expect(h.awaitCampaignSendSlot).not.toHaveBeenCalled();
    expect(h.sendLegalNoticeEmail).not.toHaveBeenCalled();
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    expect(h.sendAlert.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      source: 'legal.notice.mailer_not_configured',
    });
  });

  it('I2: any failed delivery raises ONE P1 with the count and no address', async () => {
    h.owners.push('u1', 'u2', 'u3');
    h.sendLegalNoticeEmail.mockImplementation(async d => {
      if (d.email !== 'u2@test.local') throw new Error('Resend send failed: down');
    });
    const ids: string[] = [];
    const r = await runLegalNoticeSend({ event: EVENT, step: makeStep(ids) });
    expect(r).toMatchObject({ sent: 1, failed: 2 });
    expect(ids.at(-1)).toBe('alert-failures');
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    const alert = h.sendAlert.mock.calls[0][0] as { source: string; title: string; body: string };
    expect(alert.source).toBe('legal.notice.failures');
    expect(alert.title).toContain('2 email(s) failed');
    expect(JSON.stringify(alert)).not.toContain('@test.local');
  });

  it('I2: a clean run raises no alert', async () => {
    h.owners.push('u1');
    await runLegalNoticeSend({ event: EVENT, step: makeStep() });
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});

describe('sendNextBatch: accounts that changed after the recipients were listed (M3)', () => {
  it('a deleted account and a demoted owner are failed without a mail or a pacer slot', async () => {
    seed('u1', 'u2', 'u3', 'u4');
    h.users.u1 = { deletedAt: new Date(), role: 'store_admin' };
    h.users.u2 = { deletedAt: null, role: 'staff' };
    h.users.u3 = null;
    const r = await service.sendNextBatch('op-1', 'terms', V);
    expect(r).toMatchObject({ sent: 1, failed: 3, remaining: 0 });
    expect(h.rows.map(x => [x.userId, x.status, x.error])).toEqual([
      ['u1', 'failed', 'USER_GONE'],
      ['u2', 'failed', 'NOT_RECIPIENT'],
      ['u3', 'failed', 'USER_GONE'],
      ['u4', 'sent', null],
    ]);
    expect(h.calls.filter(c => c === 'slot')).toHaveLength(1);
    expect(h.sendLegalNoticeEmail).toHaveBeenCalledTimes(1);
  });

  it('M9: a huge provider message is cut before scrubbing and stored at most 300 chars', async () => {
    seed('u1');
    h.sendLegalNoticeEmail.mockImplementation(async () => {
      throw new Error(`x@y.z ${'a'.repeat(100_000)}`);
    });
    await service.sendNextBatch('op-1', 'terms', V);
    expect(h.rows[0].error!.length).toBe(300);
    expect(h.rows[0].error!.startsWith('x***@y.z')).toBe(true);
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

  it('M1: a stale run (its send row is gone) leaves the newer send rows alone', async () => {
    seed('u1');
    await onLegalNoticeSendFailure({ ...EVENT.data, sendId: 'send-OLD' });
    expect(h.rows[0].status).toBe('queued');
  });

  it('M2: when the rows cannot be marked (sender demoted) a P1 names the document and the runbook', async () => {
    seed('u1');
    h.operatorOk = false;
    await expect(onLegalNoticeSendFailure(EVENT.data)).resolves.toBeUndefined();
    expect(h.rows[0].status).toBe('queued');
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    const a = h.sendAlert.mock.calls[0][0] as {
      level: string;
      source: string;
      title: string;
      body: string;
    };
    expect(a).toMatchObject({ level: 'p1', source: 'legal.notice.job_failed' });
    expect(a.title).toContain(`terms@${V}`);
    expect(a.body).toContain('Recover a stalled or failed run');
  });
});
