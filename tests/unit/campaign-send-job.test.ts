/**
 * Email campaigns (D2) — the Inngest `campaign-send` function.
 *
 * Runs the real handler against an in-memory Prisma that evaluates `where`
 * clauses (tests/helpers/campaign-fake-db.ts) and a step shim that memoizes
 * completed steps the way Inngest does, so a "retry" below is a faithful
 * replay: finished steps return their recorded result, the failed step runs
 * again.
 *
 * Mutation-proven (docs/plans/done/2026-09-25-email-campaigns.md, Verification):
 * deleting the `r.status !== 'queued'` idempotency guard turns
 * "a retried batch never re-sends a delivered recipient" red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createFakePrisma,
  storeRow,
  subscriberRow,
  uuid,
  STORE_A,
  type FakeDb,
} from '../helpers/campaign-fake-db';

const { holder, sendMarketingEmail, captured, awaitCampaignSendSlot } = vi.hoisted(() => {
  process.env.API_URL = 'https://api.test';
  process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'unit-test-secret';
  return {
    holder: { prisma: null as any },
    sendMarketingEmail: vi.fn(),
    captured: { config: null as any, handler: null as any },
    awaitCampaignSendSlot: vi.fn(async (_maxWaitMs?: number) => true),
  };
});

vi.mock('@api/lib/campaign-send-pacer', () => ({ awaitCampaignSendSlot }));

// The store-active guard reads the platform directory; covered in comms-jobs-skip-inactive-store.test.ts.
const storeActive = vi.hoisted(() => ({ value: true }));
vi.mock('@api/lib/jobs/store-db', async orig => ({
  ...(await orig<typeof import('@api/lib/jobs/store-db')>()),
  storeActiveForJob: vi.fn(async () => storeActive.value),
}));

// The per-batch operational read (Ruling SUSPEND-OUT-1): independent of storeActiveForJob so a store can be suspended MID-send.
const operational = vi.hoisted(() => ({ value: true, reads: 0 }));
vi.mock('@api/lib/store-operational', () => ({
  storeOperational: vi.fn(async () => {
    operational.reads++;
    return operational.value;
  }),
}));

vi.mock('@ebda/database', () => ({
  get prisma() {
    return holder.prisma;
  },
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  runInStoreScope: (_storeId: string, fn: () => unknown) => fn(),
  withStore: (_storeId: string, fn: (tx: unknown) => unknown) => fn(holder.prisma),
}));

vi.mock('@api/services/store-mailer.service', () => ({ StoreMailer: { sendMarketingEmail } }));

vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: (cfg: unknown, handler: unknown) => {
      captured.config = cfg;
      captured.handler = handler;
      return { id: 'campaign-send' };
    },
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { sendAlert } = vi.hoisted(() => ({ sendAlert: vi.fn(async () => 'sent') }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert }));

import { EmailSendError } from '@api/services/mail-transport';
import '@api/lib/inngest/functions/campaign-send';

const THROTTLE = 7;
let db: FakeDb;
let campaignId: string;
let scheduledAt: Date;

function seed(emails: string[], campaignExtra: Record<string, unknown> = {}) {
  db.stores.push(storeRow(STORE_A));
  for (const e of emails) db.subscribers.push(subscriberRow(STORE_A, e));
  campaignId = uuid();
  scheduledAt = new Date(Date.now() - 1000);
  db.campaigns.push({
    id: campaignId,
    storeId: STORE_A,
    name: 'Eid',
    subject: 'Eid sale',
    subjectAr: 'تخفيضات العيد',
    bodyHtml: '<p>Hello</p>',
    bodyHtmlAr: '<p>مرحبا</p>',
    localeStrategy: 'subscriber',
    status: 'scheduled',
    scheduledAt,
    sentAt: null,
    recipientCount: 0,
    sentCount: 0,
    failedCount: 0,
    lastError: null,
    ...campaignExtra,
  });
}

function makeStep(memo: Map<string, unknown>) {
  return {
    run: async (id: string, fn: () => unknown) => {
      if (memo.has(id)) return memo.get(id);
      const value = await fn();
      const serialized = value === undefined ? null : JSON.parse(JSON.stringify(value));
      memo.set(id, serialized);
      return serialized;
    },
    sleepUntil: vi.fn(async () => undefined),
  };
}

/** Run like Inngest: on a throw, replay with the same memo (up to `attempts`). */
async function runJob(attempts = 1, eventScheduledAt?: string) {
  const memo = new Map<string, unknown>();
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await captured.handler({
        event: {
          data: {
            campaignId,
            storeId: STORE_A,
            scheduledAt: eventScheduledAt ?? scheduledAt.toISOString(),
          },
        },
        step: makeStep(memo),
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const campaign = () => db.campaigns.find(c => c.id === campaignId)!;
const sentTo = () => sendMarketingEmail.mock.calls.map(c => c[1].to as string);

beforeEach(() => {
  db = { stores: [], campaigns: [], recipients: [], subscribers: [], customers: [] };
  holder.prisma = createFakePrisma(db);
  sendMarketingEmail.mockReset();
  awaitCampaignSendSlot.mockReset().mockImplementation(async () => true);
  let n = 0;
  sendMarketingEmail.mockImplementation(async () => ({ id: `msg-${++n}` }));
  process.env.CAMPAIGN_SEND_THROTTLE_MS = String(THROTTLE);
  delete process.env.CAMPAIGN_DAILY_SEND_CAP;
  storeActive.value = true;
  operational.value = true;
  operational.reads = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('campaign-send', () => {
  it('is triggered only by campaign/send-requested and runs one campaign at a time PER STORE', () => {
    expect(captured.config.triggers).toEqual([{ event: 'campaign/send-requested' }]);
    // #1955: keyed per store — one store's campaign never queues behind another's.
    expect(captured.config.concurrency).toEqual({ limit: 1, key: 'event.data.storeId' });
    expect(captured.config).not.toHaveProperty('cron');
  });

  it('#1955 — waits for a platform-wide send slot before EVERY send', async () => {
    seed(['a@x.test', 'b@x.test', 'c@x.test']);
    const order: string[] = [];
    awaitCampaignSendSlot.mockImplementation(async () => {
      order.push('slot');
      return true;
    });
    sendMarketingEmail.mockImplementation(async (_s: unknown, o: { to: string }) => {
      order.push(`send:${o.to}`);
      return { id: `msg-${o.to}` };
    });

    await runJob();

    expect(awaitCampaignSendSlot).toHaveBeenCalledTimes(3);
    for (let i = 0; i < order.length; i++) {
      if (order[i].startsWith('send:')) expect(order[i - 1]).toBe('slot');
    }
  });

  it('a store that stopped being active while the campaign waited sends nothing and the run is a skip, not a failure', async () => {
    seed(['a@x.test']);
    storeActive.value = false;

    await expect(runJob()).resolves.toEqual({ skipped: 'store-not-active' });

    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(campaign().status).toBe('scheduled');
  });

  it('a store suspended MID-send pauses the campaign: nothing failed, recipients stay queued, one status read per batch', async () => {
    seed(['a@x.test', 'b@x.test', 'c@x.test']);
    operational.value = false;

    await expect(runJob()).resolves.toEqual({ paused: 'store-not-operational' });

    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(db.recipients.map(r => r.status)).toEqual(['queued', 'queued', 'queued']);
    expect(campaign().status).toBe('draft');
    expect(campaign().lastError).toBe('STORE_NOT_OPERATIONAL');
    expect(operational.reads).toBe(1);
  });

  it('an operational store reads its status once per batch, not once per recipient', async () => {
    seed(['a@x.test', 'b@x.test', 'c@x.test']);
    await runJob();
    expect(sendMarketingEmail).toHaveBeenCalledTimes(3);
    expect(operational.reads).toBe(1);
    for (const c of sendMarketingEmail.mock.calls) expect(c[1].operationalChecked).toBe(true);
  });

  it('sends ONE email per consented subscriber, to one address each, then marks the campaign sent', async () => {
    seed(['a@x.test', 'b@x.test', 'c@x.test']);
    db.subscribers.push(subscriberRow(STORE_A, 'gone@x.test', { isActive: false }));

    await runJob();

    expect(sentTo().sort()).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
    for (const call of sendMarketingEmail.mock.calls) {
      expect(typeof call[1].to).toBe('string');
      expect(call[1].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(call[1].idempotencyKey).toMatch(/^campaign-recipient\//);
      expect(call[1].html).toContain('/unsubscribe?token=');
    }
    expect(db.recipients.every(r => r.status === 'sent' && r.providerMessageId)).toBe(true);
    expect(campaign()).toMatchObject({
      status: 'sent',
      recipientCount: 3,
      sentCount: 3,
      failedCount: 0,
    });
  });

  it('sleeps the throttle after each successful send', async () => {
    seed(['a@x.test', 'b@x.test']);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await runJob();
    expect(spy.mock.calls.filter(c => c[1] === THROTTLE)).toHaveLength(2);
  });

  it('a retried batch never re-sends a recipient that was already delivered', async () => {
    seed(['a@x.test', 'b@x.test', 'c@x.test']);
    // Third send hits a transient throttle → the step throws → Inngest retries.
    let calls = 0;
    sendMarketingEmail.mockImplementation(async () => {
      calls++;
      if (calls === 3) throw new EmailSendError('E_RATE_LIMIT_EXCEEDED', 'slow down');
      return { id: `msg-${calls}` };
    });

    await runJob(2);

    const counts = sentTo().reduce<Record<string, number>>((m, e) => {
      m[e] = (m[e] ?? 0) + 1;
      return m;
    }, {});
    // a and b were delivered on attempt 1 and must NOT go out again; c is
    // retried (its throttled send never went out).
    expect(counts['a@x.test']).toBe(1);
    expect(counts['b@x.test']).toBe(1);
    expect(counts['c@x.test']).toBe(2);
    expect(db.recipients.filter(r => r.status === 'sent')).toHaveLength(3);
    expect(campaign().status).toBe('sent');
  });

  it('a replayed materialize step cannot create a second recipient row', async () => {
    seed(['a@x.test']);
    await runJob();
    // Re-run materialize's write against the same campaign: the unique key wins.
    await holder.prisma.campaignRecipient.createMany({
      data: [{ campaignId, storeId: STORE_A, email: 'a@x.test', locale: 'en' }],
      skipDuplicates: true,
    });
    expect(db.recipients).toHaveLength(1);
  });

  it('a permanent provider rejection marks THAT recipient failed and the rest still send', async () => {
    seed(['a@x.test', 'bad@x.test', 'c@x.test']);
    sendMarketingEmail.mockImplementation(async (_s: unknown, o: { to: string }) => {
      if (o.to === 'bad@x.test') throw new EmailSendError('E_VALIDATION_ERROR', 'Invalid `to`');
      return { id: `msg-${o.to}` };
    });

    await runJob();

    const bad = db.recipients.find(r => r.email === 'bad@x.test')!;
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('Invalid');
    expect(db.recipients.filter(r => r.status === 'queued')).toHaveLength(0);
    expect(campaign()).toMatchObject({ status: 'sent', sentCount: 2, failedCount: 1 });
  });

  it('fails as DAILY_CAP_EXCEEDED before creating any recipient or sending anything', async () => {
    process.env.CAMPAIGN_DAILY_SEND_CAP = '2';
    seed(['a@x.test', 'b@x.test', 'c@x.test']);

    await runJob();

    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(db.recipients).toHaveLength(0);
    expect(campaign()).toMatchObject({ status: 'failed', lastError: 'DAILY_CAP_EXCEEDED' });
  });

  it('counts emails already sent in the last 24h against the cap', async () => {
    process.env.CAMPAIGN_DAILY_SEND_CAP = '3';
    seed(['a@x.test', 'b@x.test']);
    db.recipients.push(
      {
        id: uuid(),
        campaignId: 'older',
        storeId: STORE_A,
        email: 'p@x.test',
        status: 'sent',
        sentAt: new Date(),
      },
      {
        id: uuid(),
        campaignId: 'older',
        storeId: STORE_A,
        email: 'q@x.test',
        status: 'unsubscribed',
        sentAt: new Date(),
      }
    );

    await runJob();

    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(campaign().lastError).toBe('DAILY_CAP_EXCEEDED');
  });

  it("a RESUME does not count the campaign's own already-sent recipients twice against the cap", async () => {
    // cap 10, audience 8, 5 already sent by THIS campaign (paused mid-send): 3 still to send fits; 8 > 10 - 5 did not.
    process.env.CAMPAIGN_DAILY_SEND_CAP = '10';
    const emails = Array.from({ length: 8 }, (_, i) => `u${i}@x.test`);
    seed(emails);
    for (const e of emails.slice(0, 5))
      db.recipients.push({
        id: uuid(),
        campaignId,
        storeId: STORE_A,
        email: e,
        status: 'sent',
        sentAt: new Date(),
      });

    await runJob();

    expect(campaign().lastError).not.toBe('DAILY_CAP_EXCEEDED');
    expect(sentTo().sort()).toEqual(emails.slice(5).sort());
  });

  it("a resume with OTHER campaigns' sends today: cap 10, others 4, own 5 sent, audience 8 -> need 3 > headroom 1, refused", async () => {
    process.env.CAMPAIGN_DAILY_SEND_CAP = '10';
    const emails = Array.from({ length: 8 }, (_, i) => `u${i}@x.test`);
    seed(emails);
    for (const e of emails.slice(0, 5))
      db.recipients.push({
        id: uuid(),
        campaignId,
        storeId: STORE_A,
        email: e,
        status: 'sent',
        sentAt: new Date(),
      });
    for (let i = 0; i < 4; i++)
      db.recipients.push({
        id: uuid(),
        campaignId: 'other',
        storeId: STORE_A,
        email: `o${i}@x.test`,
        status: 'sent',
        sentAt: new Date(),
      });
    await runJob();
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(campaign().lastError).toBe('DAILY_CAP_EXCEEDED');
  });

  it('a resume that still has more to send than the headroom fails DAILY_CAP_EXCEEDED', async () => {
    process.env.CAMPAIGN_DAILY_SEND_CAP = '6';
    const emails = Array.from({ length: 8 }, (_, i) => `u${i}@x.test`);
    seed(emails);
    for (const e of emails.slice(0, 5))
      db.recipients.push({
        id: uuid(),
        campaignId,
        storeId: STORE_A,
        email: e,
        status: 'sent',
        sentAt: new Date(),
      });
    await runJob();
    expect(campaign().lastError).toBe('DAILY_CAP_EXCEEDED');
  });

  const sentRow = (cid: string, email: string, ago = 0) => ({
    id: uuid(),
    campaignId: cid,
    storeId: STORE_A,
    email,
    status: 'sent',
    sentAt: new Date(Date.now() - ago),
  });
  const DAY = 25 * 3600 * 1000;

  it('a resume NEXT DAY: sends outside the 24h window (and one no longer in the audience) never shrink need', async () => {
    // cap 2, audience 8 of which 5 were sent yesterday; a 6th sent-yesterday recipient has left the audience.
    // need = 3 > remaining 2 -> refuse. A bare count of own sent (6) gave need 2 -> go.
    process.env.CAMPAIGN_DAILY_SEND_CAP = '2';
    const emails = Array.from({ length: 8 }, (_, i) => `u${i}@x.test`);
    seed(emails);
    for (const e of emails.slice(0, 5)) db.recipients.push(sentRow(campaignId, e, DAY));
    db.recipients.push(sentRow(campaignId, 'gone@x.test', DAY));
    await runJob();
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(campaign().lastError).toBe('DAILY_CAP_EXCEEDED');
  });

  it('sent recipients that unsubscribed and left the audience do not reduce need', async () => {
    // 5 sent, 3 of them since unsubscribed (not in the audience); audience 6 incl. 2 already sent -> need 4 > remaining 3.
    // (cap 10, own 2 sent today in-audience + 3 gone = alreadySent 5, remaining 5? use cap 8 -> remaining 3.)
    process.env.CAMPAIGN_DAILY_SEND_CAP = '8';
    const emails = Array.from({ length: 6 }, (_, i) => `u${i}@x.test`);
    seed(emails);
    for (const e of emails.slice(0, 2)) db.recipients.push(sentRow(campaignId, e));
    for (const e of ['g0@x.test', 'g1@x.test', 'g2@x.test'])
      db.recipients.push(sentRow(campaignId, e));
    await runJob();
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(campaign().lastError).toBe('DAILY_CAP_EXCEEDED');
  });

  it('skips a subscriber who unsubscribed after the campaign was queued', async () => {
    seed(['a@x.test', 'b@x.test']);
    // Unsubscribe b between materialize and the batch.
    const realFindMany = holder.prisma.campaignRecipient.findMany;
    holder.prisma.campaignRecipient.findMany = async (args: any) => {
      const out = await realFindMany(args);
      db.subscribers.find(s => s.email === 'b@x.test')!.isActive = false;
      return out;
    };

    await runJob();

    expect(sentTo()).toEqual(['a@x.test']);
    expect(db.recipients.find(r => r.email === 'b@x.test')!.status).toBe('unsubscribed');
  });

  it('a cancel before the batch sends nothing and leaves no queued row', async () => {
    seed(['a@x.test', 'b@x.test']);
    const realFindMany = holder.prisma.campaignRecipient.findMany;
    holder.prisma.campaignRecipient.findMany = async (args: any) => {
      const out = await realFindMany(args);
      campaign().status = 'cancelled';
      return out;
    };

    await runJob();

    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(db.recipients.every(r => r.status === 'failed' && r.error === 'CANCELLED')).toBe(true);
    expect(campaign().status).toBe('cancelled');
  });

  it('ignores an event whose scheduledAt nonce no longer matches (rolled-back or superseded request)', async () => {
    seed(['a@x.test']);
    await runJob(1, new Date(scheduledAt.getTime() - 60_000).toISOString());
    expect(sendMarketingEmail).not.toHaveBeenCalled();
    expect(campaign().status).toBe('scheduled');
  });

  it('never sends a draft — it throws so the step retries until the request commits', async () => {
    seed(['a@x.test'], { status: 'draft' });
    await expect(runJob(1)).rejects.toThrow(/still draft/);
    expect(sendMarketingEmail).not.toHaveBeenCalled();
  });

  it('onFailure marks the campaign and every still-queued recipient failed', async () => {
    seed(['a@x.test']);
    campaign().status = 'sending';
    db.recipients.push({
      id: uuid(),
      campaignId,
      storeId: STORE_A,
      email: 'a@x.test',
      status: 'queued',
      sentAt: null,
    });

    await captured.config.onFailure({
      event: {
        data: {
          event: { data: { campaignId, storeId: STORE_A, scheduledAt: scheduledAt.toISOString() } },
        },
      },
      error: new Error('boom'),
    });

    expect(campaign()).toMatchObject({ status: 'failed', lastError: 'SEND_JOB_FAILED' });
    expect(db.recipients[0]).toMatchObject({ status: 'failed', error: 'SEND_JOB_FAILED' });
  });

  it('#1952 — onFailure reconciles recipientCount/sentCount/failedCount instead of leaving them at their pre-run value', async () => {
    seed(['sent@x.test', 'queued@x.test', 'failed@x.test'], {
      status: 'sending',
      recipientCount: 0,
      sentCount: 0,
      failedCount: 0,
    });
    db.recipients.push(
      {
        id: uuid(),
        campaignId,
        storeId: STORE_A,
        email: 'sent@x.test',
        status: 'sent',
        sentAt: new Date(),
      },
      {
        id: uuid(),
        campaignId,
        storeId: STORE_A,
        email: 'queued@x.test',
        status: 'queued',
        sentAt: null,
      },
      {
        id: uuid(),
        campaignId,
        storeId: STORE_A,
        email: 'failed@x.test',
        status: 'failed',
        sentAt: null,
      }
    );

    await captured.config.onFailure({
      event: {
        data: {
          event: { data: { campaignId, storeId: STORE_A, scheduledAt: scheduledAt.toISOString() } },
        },
      },
      error: new Error('boom'),
    });

    // The still-queued recipient is now failed too, so the true breakdown is
    // 1 sent, 2 failed, 3 total — not the 0/0/0 the campaign started this run
    // with. Without the fix these three columns stayed untouched.
    expect(campaign()).toMatchObject({
      status: 'failed',
      recipientCount: 3,
      sentCount: 1,
      failedCount: 2,
    });
  });
});

/**
 * issue 2115 — one batch step is one HTTP request behind Cloudflare's 100s
 * edge timeout. With many stores sharing the platform pacer, a 20-recipient
 * batch could outlive it; after the retries `onFailure` marked never-mailed
 * recipients failed. A step now stops inside its budget and the rest resume
 * in leftover steps. Mutation-proof: ignoring the pacer's `false` (or dropping
 * the leftover passes) reddens these.
 */
describe('campaign-send — batch wall-clock budget (issue 2115)', () => {
  it('a step whose next pacer slot is past its budget stops, and the rest are sent in later steps', async () => {
    seed(['a@x.test', 'b@x.test', 'c@x.test']);
    // The 2nd slot is "too far away" once; everything else is immediate.
    let calls = 0;
    awaitCampaignSendSlot.mockImplementation(async () => ++calls !== 2);

    await runJob();

    expect(sentTo().sort()).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
    expect(campaign().status).toBe('sent');
    expect(db.recipients.every(r => r.status === 'sent')).toBe(true);
  });

  it('passes the remaining budget to the pacer (never an unbounded wait)', async () => {
    seed(['a@x.test']);
    await runJob();
    const [maxWait] = awaitCampaignSendSlot.mock.calls[0] as [number];
    expect(Number.isFinite(maxWait)).toBe(true);
    expect(maxWait).toBeLessThanOrEqual(60_000);
    expect(maxWait).toBeGreaterThan(0);
  });
});

/**
 * issue 2297 — when the leftover passes run out with recipients still
 * `queued`, those recipients were never mailed. They used to be invisible:
 * the campaign finalized as `sent`, the counts ignored `queued`, and nothing
 * alerted. Mutation-proof: dropping the stranded-recipient update in
 * `finalize` leaves them queued and reddens this.
 */
describe('campaign-send — leftover cap exhaustion (issue 2297)', () => {
  beforeEach(() => sendAlert.mockClear());
  it('fails still-queued recipients loudly instead of hiding them behind a sent campaign', async () => {
    seed(['a@x.test', 'b@x.test', 'c@x.test']);
    // Only the very first slot is ever granted; every later one defers.
    let calls = 0;
    awaitCampaignSendSlot.mockImplementation(async () => ++calls === 1);

    await runJob();

    expect(sentTo()).toHaveLength(1);
    expect(db.recipients.some(r => r.status === 'queued')).toBe(false);
    const stranded = db.recipients.filter(r => r.error === 'SEND_WINDOW_EXHAUSTED');
    expect(stranded).toHaveLength(2);
    expect(campaign()).toMatchObject({ recipientCount: 3, sentCount: 1, failedCount: 2 });
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'campaign.send.window_exhausted' })
    );
  });

  it('bounds the steps one run can spend on leftover passes', async () => {
    seed(['a@x.test', 'b@x.test']);
    awaitCampaignSendSlot.mockImplementation(async () => false);
    const memo = new Map<string, unknown>();
    const step = makeStep(memo);
    await captured.handler({
      event: { data: { campaignId, storeId: STORE_A, scheduledAt: scheduledAt.toISOString() } },
      step,
    });
    const leftoverSteps = [...memo.keys()].filter(k => k.startsWith('leftover-'));
    expect(leftoverSteps.length).toBeLessThanOrEqual(400);
  });

  it('a normal campaign raises no stranded alert', async () => {
    seed(['a@x.test']);
    await runJob();
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
