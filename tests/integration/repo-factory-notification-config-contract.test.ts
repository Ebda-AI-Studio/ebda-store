/**
 * INFRA-CF-1 final integration (Ruling CF-NOTIFY-1): the notification channel config the push / SMS / WhatsApp dispatchers read
 * (`notification-config.service.ts`) on the StoreDO gives the same answers and leaves the same rows as the Postgres twin. Each scenario runs the real service once on Postgres (unchanged code) and once with the DO money client over the
 * real DO schema on SQLite; the traces must be equal.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@ebda/database';
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
import {
  makeMoneyClient,
  storeDb,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { hasDb } from '../helpers/bundle-fixtures';
import { featureService } from '../../apps/api/src/services/feature.service';
import { notificationConfigService } from '../../apps/api/src/services/notification-config.service';
import { notificationDispatcher } from '../../apps/api/src/services/notification-dispatcher.service';
import { smsQueue } from '../../apps/api/src/services/sms-queue.service';
import { pushService } from '../../apps/api/src/services/push.service';
import { redis } from '../../apps/api/src/services/redis.service';

const sfx = Date.now().toString(36);
let STORE = '';
let ownerId = '';
const sqlite = openSqlite();

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    money,
  };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown, names: Record<string, string>, sfxk = ''): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  if (sfxk) text = text.split(`-${sfxk}`).join('-<k>');
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(
    text
      .replace(UUID, '<id>')
      .replace(/ORD-[A-Z0-9-]+/g, '<no>')
      .replace(/\b\d{12}\b/g, '<ref>')
      .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
  );
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        status: e.statusCode,
        code: e.code,
        message: e.code ? undefined : String(e.message).slice(0, 120),
      },
    })
  );

let n = 0;
async function world(_mirror: boolean) {
  return { k: `${sfx}${++n}` };
}
type W = Awaited<ReturnType<typeof world>>;

async function state() {
  const db = (await storeDb(STORE)) as any;
  const cfg = await db.notificationConfig.findMany({
    where: { storeId: STORE },
    select: { channel: true, provider: true, enabled: true, credentials: true },
    orderBy: { channel: 'asc' },
  });
  const ev = await db.notificationEventConfig.findMany({
    where: { storeId: STORE },
    select: { event: true, whatsapp: true, sms: true, push: true },
    orderBy: { event: 'asc' },
  });
  // the stored credentials are encrypted with a random IV: compare what they decrypt to
  const { encryption } = await import('../../apps/api/src/services/encryption.service');
  return {
    cfg: cfg.map((c: any) => ({
      ...c,
      credentials: c.credentials ? JSON.parse(encryption.decrypt(c.credentials)) : null,
    })),
    ev,
  };
}

async function parity(act: (w: W) => Promise<unknown>) {
  const run = async (on: typeof onPg, mirror: boolean) => {
    await prisma.notificationConfig.deleteMany({ where: { storeId: STORE } });
    await prisma.notificationEventConfig.deleteMany({ where: { storeId: STORE } });
    sqlite.exec('DELETE FROM notification_configs; DELETE FROM notification_event_configs');
    await redis.delete(`notification:config:${STORE}`).catch(() => undefined);
    const w = await world(mirror);
    const out = await settle(() => on(() => act(w)));
    return scrub({ out, state: await on(() => state()) }, {}, w.k);
  };
  const pg = await run(onPg, false);
  const dobj = await run(onDo, true);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `nc-${sfx}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'N',
      lastName: 'C',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  STORE = (
    await prisma.store.create({
      data: {
        name: 'NcDo',
        slug: `ncdo-${sfx}`,
        ownerId: owner.id,
        status: 'active',
        plan: 'enterprise',
      },
    })
  ).id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const SMS = {
  provider: 'unifonic',
  enabled: true,
  credentials: { appSid: 'APPSID-1234567890', senderId: 'EBDA' },
};

describe.skipIf(!hasDb)('notification config on Postgres vs the DO', () => {
  it('upsert stores the channel with encrypted credentials; a read returns them decrypted; a second upsert updates the same row', async () => {
    const t = await parity(async () => {
      const first = await notificationConfigService.upsertConfig(STORE, 'sms', SMS);
      const read = await notificationConfigService.getConfig(STORE, 'sms');
      const again = await notificationConfigService.upsertConfig(STORE, 'sms', {
        ...SMS,
        enabled: false,
      });
      return { first, read, again };
    });
    expect(t.out.ok.first.credentials.appSid).toBe('APPSID-1234567890');
    expect(t.out.ok.again.enabled).toBe(false);
    expect(t.state.cfg).toHaveLength(1);
  });

  it('a masked credential coming back from the admin form keeps the stored secret', async () => {
    const t = await parity(async () => {
      await notificationConfigService.upsertConfig(STORE, 'sms', SMS);
      return notificationConfigService.upsertConfig(STORE, 'sms', {
        ...SMS,
        credentials: { appSid: '****7890', senderId: 'EBDA2' },
      });
    });
    expect(t.state.cfg[0].credentials).toEqual({ appSid: 'APPSID-1234567890', senderId: 'EBDA2' });
  });

  it('delete removes the channel; event switches upsert per event and default to absent', async () => {
    const t = await parity(async () => {
      await notificationConfigService.upsertConfig(STORE, 'sms', SMS);
      await notificationConfigService.upsertConfig(STORE, 'push', {
        provider: 'onesignal',
        enabled: true,
        credentials: { appId: 'a' },
      });
      await notificationConfigService.deleteConfig(STORE, 'sms');
      const e1 = await notificationConfigService.upsertEventConfig(STORE, 'order_created', {
        whatsapp: true,
        sms: false,
        push: true,
      });
      const e2 = await notificationConfigService.upsertEventConfig(STORE, 'order_created', {
        whatsapp: false,
        sms: false,
        push: true,
      });
      return {
        e1,
        e2,
        all: await notificationConfigService.getEventConfigs(STORE),
        channels: Object.keys(await notificationConfigService.getStoreConfigs(STORE)),
      };
    });
    expect(t.out.ok.channels).toEqual(['push']);
    expect(t.out.ok.all.order_created).toEqual({ whatsapp: false, sms: false, push: true });
    expect(t.state.ev).toHaveLength(1);
  });

  it('an OFF switch written on the store suppresses the send on both backends (the dispatcher reads where the admin writes)', async () => {
    vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(true);
    const sms = vi.spyOn(smsQueue, 'enqueue').mockResolvedValue(undefined as never);
    const push = vi.spyOn(pushService, 'sendToStore').mockResolvedValue(undefined as never);
    const send = () =>
      notificationDispatcher.dispatch(
        STORE,
        'order_confirmed' as never,
        {
          orderNumber: 'ORD-1',
          customerPhone: '+201001234567',
          locale: 'en',
          storeName: 'S',
        } as never
      );
    const t = await parity(async () => {
      await notificationConfigService.upsertConfig(STORE, 'sms', SMS);
      await notificationConfigService.upsertConfig(STORE, 'push', {
        provider: 'onesignal',
        enabled: true,
        credentials: { appId: 'a', apiKey: 'k' },
      });
      sms.mockClear();
      push.mockClear();
      await send();
      const on = { sms: sms.mock.calls.length, push: push.mock.calls.length };
      await notificationConfigService.upsertEventConfig(STORE, 'order_confirmed', {
        whatsapp: true,
        sms: false,
        push: false,
      });
      sms.mockClear();
      push.mockClear();
      await send();
      const off = { sms: sms.mock.calls.length, push: push.mock.calls.length };
      const cfg = await notificationDispatcher.getEventConfig(STORE, 'order_confirmed' as never);
      return { on, off, cfg };
    });
    expect(t.out.ok.on).toEqual({ sms: 1, push: 1 });
    expect(t.out.ok.off).toEqual({ sms: 0, push: 0 });
    expect(t.out.ok.cfg).toEqual({ sms: false, push: false });
    vi.restoreAllMocks();
  });
});
