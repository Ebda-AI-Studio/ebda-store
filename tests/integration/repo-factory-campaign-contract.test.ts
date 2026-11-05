/**
 * INFRA-CF-1 R6a (Ruling CF-R6A-2): an e-mail campaign of a Durable Object store behaves exactly like one on Postgres. The REAL
 * admin router, the REAL public unsubscribe router and the REAL `campaign-send` job run once on Postgres (unchanged code) and
 * once over the real DO schema on SQLite, on the same fixtures; the traces (responses, mails handed to the mailer, and the
 * campaign + recipient + subscriber rows afterwards) must be equal.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { makeMoneyClient, withRepo, storeDb } from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { withPgStoreDelegate } from '../helpers/do-store-delegate';

const { captured, sendMarketingEmail, send } = vi.hoisted(() => {
  process.env.API_URL = 'https://api.test';
  process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'contract-test-secret';
  process.env.CAMPAIGN_SEND_THROTTLE_MS = '0';
  return {
    captured: { handler: null as any },
    sendMarketingEmail: vi.fn(),
    send: vi.fn(async () => ({ ids: [] })),
  };
});
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/lib/campaign-send-pacer', () => ({
  awaitCampaignSendSlot: vi.fn(async () => true),
}));
vi.mock('../../apps/api/src/services/store-mailer.service', () => ({
  StoreMailer: { sendMarketingEmail },
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    send,
    createFunction: (_cfg: unknown, handler: unknown) => {
      captured.handler = handler;
      return { id: 'campaign-send' };
    },
  },
}));

const { awaitDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { tenantContext } = await import('../../apps/api/src/middleware/tenant-context');
const { default: campaignRoutes } = await import('../../apps/api/src/routes/campaign.routes');
const { default: publicRoutes } = await import('../../apps/api/src/routes/campaign-public.routes');
await import('../../apps/api/src/lib/inngest/functions/campaign-send');
const { signUnsubscribeToken } = await import('../../apps/api/src/lib/campaign-unsubscribe-token');
const { EmailSendError } = await import('../../apps/api/src/services/mail-transport');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const tag = `cc${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
const sqlite = openSqlite();
const ids = { owner: '', store: '' };
let doRepo: any;

function buildDoRepo(storeId: string) {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, storeId, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return { storeId, backend: 'do' as const, db: withPgStoreDelegate(c), writer: c, money };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const run = () =>
      new Promise<void>(resolve => {
        res.once('finish', resolve);
        res.once('close', resolve);
        next();
      });
    asApp(() => (req.header('x-test-backend') === 'do' ? withRepo(doRepo, run) : run())).catch(
      next
    );
  });
  app.use('/api/v1/stores/:storeId', tenantContext);
  app.use('/api/v1/stores/:storeId/campaigns', campaignRoutes);
  app.use('/api/v1/public/campaigns', publicRoutes);
  app.use(errorHandler);
  return app;
}

type Backend = 'pg' | 'do';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const scrub = (v: unknown, keep: Record<string, string> = {}): unknown => {
  let text = JSON.stringify(canon(v)) ?? 'null';
  for (const [id, name] of Object.entries(keep)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
      .replace(/token=[A-Za-z0-9_.%~-]+/g, 'token=<t>')
  );
};

let n = 0;
/** One campaign + subscribers, written to Postgres, then copied row for row into the DO schema. */
async function world(opts: {
  campaignStatus?: string;
  subs: Array<[string, Record<string, unknown>?]>;
}) {
  // a clean slate on both sides: the audience is the whole store's consented list
  await prisma.$executeRaw`DELETE FROM public.campaign_recipients WHERE store_id = ${ids.store}`;
  await prisma.$executeRaw`DELETE FROM public.campaigns WHERE store_id = ${ids.store}`;
  await prisma.$executeRaw`DELETE FROM public.newsletter_subscribers WHERE store_id = ${ids.store}`;
  for (const t of ['campaign_recipients', 'campaigns', 'newsletter_subscribers'])
    sqlite.exec(`DELETE FROM ${t}`);
  const k = `${tag}${++n}`;
  const campaign = await prisma.campaign.create({
    data: {
      storeId: ids.store,
      name: `Eid ${k}`,
      subject: 'Eid sale',
      subjectAr: 'تخفيضات العيد',
      bodyHtml: '<p>Hello</p>',
      bodyHtmlAr: '<p>مرحبا</p>',
      localeStrategy: 'subscriber',
      status: (opts.campaignStatus ?? 'scheduled') as never,
      scheduledAt: opts.campaignStatus === 'draft' ? null : new Date(Date.now() - 5000),
    },
  });
  const subs = [];
  for (const [email, extra] of opts.subs)
    subs.push(
      await prisma.newsletterSubscriber.create({
        data: { storeId: ids.store, email: `${k}.${email}`, ...extra } as never,
      })
    );
  insertSqlite(sqlite, 'Campaign', [campaign] as never);
  insertSqlite(sqlite, 'NewsletterSubscriber', subs as never);
  return { campaign, subs, k };
}

const stateOf = async (campaignId: string) => {
  const db = (await storeDb(ids.store)) as any;
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId },
    select: {
      status: true,
      recipientCount: true,
      sentCount: true,
      failedCount: true,
      lastError: true,
    },
  });
  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId },
    select: { email: true, locale: true, status: true, error: true, subscriberId: true },
    orderBy: { email: 'asc' },
  });
  const subs = await db.newsletterSubscriber.findMany({
    where: { storeId: ids.store, email: { startsWith: tag } },
    select: { email: true, isActive: true },
    orderBy: { email: 'asc' },
  });
  // Postgres orders text by the database collation (punctuation-insensitive on a glibc/ICU locale: '.c@' vs '.cart@'), SQLite
  // by bytes: compare both backends in one byte order instead of trusting either ORDER BY.
  const byEmail = (a: { email: string }, b: { email: string }) =>
    a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  return { campaign, recipients: [...recipients].sort(byEmail), subs: [...subs].sort(byEmail) };
};

async function runJob(c: { id: string; scheduledAt: Date | null }) {
  sendMarketingEmail.mockClear();
  const memo = new Map<string, unknown>();
  const step = {
    run: async (id: string, fn: () => unknown) => {
      if (memo.has(id)) return memo.get(id);
      const value = await fn();
      const ser = value === undefined ? null : JSON.parse(JSON.stringify(value));
      memo.set(id, ser);
      return ser;
    },
    sleepUntil: vi.fn(async () => undefined),
  };
  const result = await captured.handler({
    event: {
      data: { campaignId: c.id, storeId: ids.store, scheduledAt: c.scheduledAt!.toISOString() },
    },
    step,
  });
  const mails = sendMarketingEmail.mock.calls.map(([, m]) => ({
    to: m.to,
    subject: m.subject,
    hasUnsubscribe: /unsubscribe\?token=/.test(m.html),
    headers: Object.keys(m.headers ?? {}).sort(),
    key: String(m.idempotencyKey).replace(UUID, '<id>'),
  }));
  mails.sort((a, b) => (a.to < b.to ? -1 : 1));
  return { result, mails, state: await stateOf(c.id) };
}

describe.skipIf(!hasDb)('e-mail campaigns: Postgres vs the store DO', () => {
  let app: Express;
  beforeAll(async () => {
    app = buildApp();
    ids.owner = (
      await prisma.user.create({
        data: {
          email: `${tag}@x.test`,
          passwordHash: 'x',
          firstName: 'Cc',
          lastName: 'Owner',
          role: 'store_admin',
        },
      })
    ).id;
    ids.store = (
      await prisma.store.create({ data: { name: tag, slug: tag, ownerId: ids.owner } })
    ).id;
    doRepo = buildDoRepo(ids.store);
  }, 90_000);
  afterAll(async () => {
    if (ids.store) {
      await prisma.$executeRaw`DELETE FROM public.campaign_recipients WHERE store_id = ${ids.store}`;
      await prisma.$executeRaw`DELETE FROM public.campaigns WHERE store_id = ${ids.store}`;
      await prisma.$executeRaw`DELETE FROM public.newsletter_subscribers WHERE store_id = ${ids.store}`;
      await prisma.store.delete({ where: { id: ids.store } }).catch(() => undefined);
    }
    if (ids.owner) await prisma.user.delete({ where: { id: ids.owner } }).catch(() => undefined);
  }, 60_000);

  const onBackend = <T>(b: Backend, f: () => Promise<T>) =>
    b === 'do' ? withRepo(doRepo, f) : f();

  it('the job mails each consented subscriber once, in their language, and ends sent with the same counts', async () => {
    const w = await world({
      subs: [
        ['a@x.test', { language: 'ar' }],
        ['b@x.test', { language: 'en' }],
        ['c@x.test', {}],
        ['gone@x.test', { isActive: false, unsubscribedAt: new Date() }],
        ['cart@x.test', { consentScope: 'cart_reminders' }],
      ],
    });
    sendMarketingEmail.mockReset().mockImplementation(async (_s: unknown, m: { to: string }) => {
      if (m.to.endsWith('c@x.test'))
        throw new EmailSendError('rejected', 'mailbox full', false as never);
      return { id: `msg-${m.to}` };
    });
    const traces = {} as Record<Backend, unknown>;
    for (const b of ['pg', 'do'] as const)
      traces[b] = scrub(await onBackend(b, () => runJob(w.campaign)), { [w.k]: 'k' });
    expect(traces.do).toEqual(traces.pg);
    const t = traces.pg as any;
    expect(t.mails.map((m: { to: string }) => m.to)).toHaveLength(3);
    expect(t.state.campaign).toMatchObject({
      status: 'sent',
      recipientCount: 3,
      sentCount: 2,
      failedCount: 1,
    });
  });

  it('a daily cap smaller than the audience, and an empty audience, abort the same way', async () => {
    for (const [label, subs, cap] of [
      ['cap', [['a@x.test'], ['b@x.test']], '1'],
      ['empty', [] as Array<[string]>, undefined],
    ] as const) {
      const w = await world({ subs: subs as never });
      if (cap) process.env.CAMPAIGN_DAILY_SEND_CAP = cap;
      try {
        sendMarketingEmail.mockReset().mockResolvedValue({ id: 'm' });
        const traces = {} as Record<Backend, unknown>;
        for (const b of ['pg', 'do'] as const)
          traces[b] = scrub(await onBackend(b, () => runJob(w.campaign)), { [w.k]: 'k' });
        expect(traces.do, label).toEqual(traces.pg);
        expect((traces.pg as any).state.campaign.status, label).toBe('failed');
        expect((traces.pg as any).mails, label).toEqual([]);
      } finally {
        delete process.env.CAMPAIGN_DAILY_SEND_CAP;
      }
    }
  });

  it('a subscriber who withdrew consent after materialising is skipped, not mailed', async () => {
    const w = await world({
      subs: [
        ['a@x.test', {}],
        ['b@x.test', {}],
      ],
    });
    sendMarketingEmail.mockReset().mockImplementation(async (_s: unknown, m: { to: string }) => {
      // the second subscriber unsubscribes while the first is being mailed
      if (m.to.endsWith('a@x.test')) {
        const db = (await storeDb(ids.store)) as any;
        await (await import('../../apps/api/src/lib/repo-factory'))
          .storeWriter(ids.store)
          .then(wr =>
            wr.newsletterSubscriber.updateMany({
              where: { storeId: ids.store, email: `${w.k}.b@x.test` },
              data: { isActive: false, unsubscribedAt: new Date() },
            })
          );
        void db;
      }
      return { id: `msg-${m.to}` };
    });
    const traces = {} as Record<Backend, unknown>;
    for (const b of ['pg', 'do'] as const)
      traces[b] = scrub(await onBackend(b, () => runJob(w.campaign)), { [w.k]: 'k' });
    expect(traces.do).toEqual(traces.pg);
    expect((traces.pg as any).mails).toHaveLength(1);
  });

  const call = (
    b: Backend,
    method: 'get' | 'post' | 'put' | 'delete',
    url: string,
    body?: object
  ) => {
    const r = request(app)[method](`/api/v1/${url}`).set('x-test-backend', b);
    return body ? r.send(body) : r;
  };

  it('the admin API: draft, list, detail, edit, send, refuse a second send, cancel, delete', async () => {
    const draft = {
      name: 'Launch',
      subject: 'Hi',
      subjectAr: 'اهلا',
      bodyHtml: '<p>x</p>',
      bodyHtmlAr: '<p>ي</p>',
      localeStrategy: 'subscriber',
      audience: { source: 'newsletter' },
    };
    // one consented subscriber on both sides so a send is possible
    const w = await world({ campaignStatus: 'draft', subs: [['a@x.test', {}]] });
    const traces = {} as Record<Backend, unknown[]>;
    for (const b of ['pg', 'do'] as const) {
      send.mockClear();
      const out: unknown[] = [];
      const rec = async (p: Promise<request.Response>) => {
        const r = await p;
        out.push({ status: r.status, body: r.body });
        return r;
      };
      const base = `stores/${ids.store}/campaigns`;
      const created = await rec(call(b, 'post', base, draft));
      const id = created.body.data?.campaign?.id as string;
      await rec(call(b, 'get', base));
      await rec(call(b, 'get', `${base}/${id}`));
      await rec(call(b, 'put', `${base}/${id}`, { ...draft, name: 'Launch 2' }));
      await rec(call(b, 'get', `${base}/${id}/recipients`));
      await rec(call(b, 'post', `${base}/${id}/send`, {}));
      out.push({ enqueued: send.mock.calls.map(c => (c[0] as any).name) });
      await rec(call(b, 'post', `${base}/${id}/send`, {}));
      await rec(call(b, 'put', `${base}/${id}`, draft));
      await rec(call(b, 'delete', `${base}/${id}`));
      await rec(call(b, 'post', `${base}/${id}/cancel`, {}));
      await rec(call(b, 'delete', `${base}/${id}`));
      await rec(call(b, 'get', `${base}/${id}`));
      // enqueue failure: the campaign goes back to draft and nothing is queued
      const c2 = await rec(call(b, 'post', base, draft));
      const id2 = c2.body.data.campaign.id as string;
      send.mockRejectedValueOnce(new Error('inngest down'));
      await rec(call(b, 'post', `${base}/${id2}/send`, {}));
      await rec(call(b, 'get', `${base}/${id2}`));
      traces[b] = out.map(o => scrub(o, { [w.k]: 'k' }));
    }
    expect(traces.do).toEqual(traces.pg);
    const sendReplies = (traces.pg as any[]).filter(o => o.status === 202 || o.status === 503);
    expect(sendReplies.map(o => o.status)).toEqual([202, 503]);
    const last = (traces.pg as any[]).at(-1);
    expect(last.body.data.campaign.status).toBe('draft');
  });

  it('public unsubscribe: preview does nothing, the POST withdraws consent and is idempotent', async () => {
    const w = await world({
      subs: [
        ['a@x.test', {}],
        ['b@x.test', {}],
      ],
    });
    sendMarketingEmail.mockReset().mockResolvedValue({ id: 'm' });
    const traces = {} as Record<Backend, unknown[]>;
    for (const b of ['pg', 'do'] as const) {
      const run = await onBackend(b, () => runJob(w.campaign));
      const db = (await onBackend(b, () => storeDb(ids.store))) as any;
      const rows = await onBackend(b, () =>
        db.campaignRecipient.findMany({
          where: { campaignId: w.campaign.id },
          orderBy: { email: 'asc' },
        })
      );
      const token = signUnsubscribeToken(ids.store, rows[0].id);
      const out: unknown[] = [run.result];
      for (const [m, url] of [
        ['get', `public/campaigns/unsubscribe?token=${token}`],
        ['post', `public/campaigns/unsubscribe?token=${token}`],
        ['post', `public/campaigns/unsubscribe?token=${token}`],
        ['get', `public/campaigns/unsubscribe?token=${token}`],
      ] as const) {
        const r = await call(b, m, url);
        out.push({ status: r.status, body: r.body });
      }
      out.push((await onBackend(b, () => stateOf(w.campaign.id))).subs);
      out.push((await onBackend(b, () => stateOf(w.campaign.id))).recipients.map(r => r.status));
      traces[b] = out.map(o => scrub(o, { [w.k]: 'k' }));
      if (b === 'pg') {
        // the same recipient ids exist only on the backend that created them; the DO run re-materialises
      }
    }
    expect(traces.do).toEqual(traces.pg);
    expect((traces.pg as any[])[2].body.data.unsubscribed).toBe(true);
  });
});
