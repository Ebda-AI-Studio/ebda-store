import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createDoClient } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 final integration (Ruling CF-NOTIFY-1): the notification channel config on real workerd. The Postgres unique
// (store, channel) and (store, event) are the DO's single thread: any number of concurrent upserts of one key leave one row
// holding one of the written values, never a torn mix, and a delete racing upserts leaves zero or one row.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const clientFor = (storeId: string) => {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
  return createDoClient(
    q => stub.query(storeId, q as never),
    m => stub.mutate(storeId, m as never)
  ) as any;
};
const upsertChannel = (c: any, storeId: string, provider: string, enabled: boolean) =>
  c.notificationConfig.upsert({
    where: { storeId_channel: { storeId, channel: 'sms' } },
    create: { storeId, channel: 'sms', provider, credentials: `enc-${provider}`, enabled },
    update: { provider, credentials: `enc-${provider}`, enabled },
  });

describe('notification config on the store DO', () => {
  it('40 concurrent upserts of one channel leave exactly one row, internally consistent', async () => {
    const store = 'nc-race';
    const c = clientFor(store);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => upsertChannel(c, store, `p${i}`, i % 2 === 0))
    );
    const rows = await c.notificationConfig.findMany({ where: { storeId: store } });
    expect(rows).toHaveLength(1);
    expect(rows[0].credentials).toBe(`enc-${rows[0].provider}`); // provider and credentials come from the same write
  });

  it('40 concurrent event-switch upserts of one event leave one row; another event is untouched', async () => {
    const store = 'nc-event';
    const c = clientFor(store);
    await c.notificationEventConfig.create({
      data: { storeId: store, event: 'refund', whatsapp: true, sms: true, push: true },
    });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        c.notificationEventConfig.upsert({
          where: { storeId_event: { storeId: store, event: 'order_created' } },
          create: {
            storeId: store,
            event: 'order_created',
            whatsapp: i % 2 === 0,
            sms: false,
            push: true,
          },
          update: { whatsapp: i % 2 === 0, sms: false, push: true },
        })
      )
    );
    expect(
      await c.notificationEventConfig.count({ where: { storeId: store, event: 'order_created' } })
    ).toBe(1);
    const refund = await c.notificationEventConfig.findFirst({
      where: { storeId: store, event: 'refund' },
    });
    expect(refund).toMatchObject({ whatsapp: true, sms: true, push: true });
  });

  it('a delete racing upserts leaves zero or one row, never two', async () => {
    const store = 'nc-del';
    const c = clientFor(store);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => upsertChannel(c, store, `p${i}`, true)),
      c.notificationConfig.deleteMany({ where: { storeId: store, channel: 'sms' } }),
      ...Array.from({ length: 10 }, (_, i) => upsertChannel(c, store, `q${i}`, false)),
    ]);
    expect(await c.notificationConfig.count({ where: { storeId: store } })).toBeLessThanOrEqual(1);
  });
});
