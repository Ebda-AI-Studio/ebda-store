import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createDoClient } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 R6a (Ruling CF-R6A-2) on real workerd, no Postgres. The campaign flow leans on conditional single-statement writes
// (claim scheduled -> sending, queued -> sent, the delete guard that refuses a campaign with send history); the single DO
// thread must give each the exactly-once result the Postgres statement did.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const clientFor = (storeId: string) => {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
  return createDoClient(
    q => stub.query(storeId, q as never),
    m => stub.mutate(storeId, m as never)
  ) as any;
};
const draft = (storeId: string, status = 'scheduled') => ({
  storeId,
  name: 'Eid',
  subject: 'Eid sale',
  bodyHtml: '<p>x</p>',
  localeStrategy: 'subscriber',
  status,
  scheduledAt: new Date(1_800_000_000_000),
});

describe('email campaigns on the store DO', () => {
  it('30 concurrent claims of one scheduled campaign: exactly one wins', async () => {
    const s = 'camp-claim';
    const c = clientFor(s);
    const row = await c.campaign.create({ data: draft(s) });
    const r = await Promise.all(
      Array.from({ length: 30 }, () =>
        c.campaign.updateMany({
          where: { id: row.id, storeId: s, status: 'scheduled', scheduledAt: row.scheduledAt },
          data: { status: 'sending' },
        })
      )
    );
    expect(r.filter((x: { count: number }) => x.count === 1)).toHaveLength(1);
    expect((await c.campaign.findFirst({ where: { id: row.id } })).status).toBe('sending');
  });

  it('25 concurrent sends of one queued recipient record one sent row; the idempotency guard turns the rest into no-ops', async () => {
    const s = 'camp-recipient';
    const c = clientFor(s);
    const camp = await c.campaign.create({ data: draft(s, 'sending') });
    const rec = await c.campaignRecipient.create({
      data: { campaignId: camp.id, storeId: s, email: 'a@example.test', locale: 'en' },
    });
    const r = await Promise.all(
      Array.from({ length: 25 }, () =>
        c.campaignRecipient.updateMany({
          where: { id: rec.id, storeId: s, status: 'queued' },
          data: { status: 'sent', sentAt: new Date(), providerMessageId: 'm1' },
        })
      )
    );
    expect(r.reduce((n: number, x: { count: number }) => n + x.count, 0)).toBe(1);
  });

  it('the recipient list is unique per campaign and e-mail: 30 concurrent materialisations leave one row each', async () => {
    const s = 'camp-materialise';
    const c = clientFor(s);
    const camp = await c.campaign.create({ data: draft(s, 'sending') });
    const data = ['a', 'b', 'c'].map(x => ({
      campaignId: camp.id,
      storeId: s,
      email: `${x}@example.test`,
      locale: 'en',
    }));
    await Promise.all(
      Array.from({ length: 30 }, () =>
        c.campaignRecipient.createMany({ data, skipDuplicates: true })
      )
    );
    expect(await c.campaignRecipient.count({ where: { campaignId: camp.id } })).toBe(3);
  });

  it('a delete racing the first send never loses send history: a campaign with a sent recipient is not deleted', async () => {
    const s = 'camp-delete';
    const c = clientFor(s);
    const camp = await c.campaign.create({ data: draft(s, 'failed') });
    const rec = await c.campaignRecipient.create({
      data: { campaignId: camp.id, storeId: s, email: 'a@example.test', locale: 'en' },
    });
    const del = () =>
      c.campaign.deleteMany({
        where: {
          id: camp.id,
          storeId: s,
          status: { in: ['draft', 'cancelled', 'failed'] },
          recipients: { none: { sentAt: { not: null } } },
        },
      });
    const [a, b] = await Promise.all([
      c.campaignRecipient.updateMany({
        where: { id: rec.id, storeId: s, status: 'queued' },
        data: { status: 'sent', sentAt: new Date() },
      }),
      del(),
    ]);
    const stillThere = (await c.campaign.count({ where: { id: camp.id } })) === 1;
    // either the delete ran first (the send then matched nothing) or the send did (the delete refused): never sent AND gone
    expect(a.count === 1 ? stillThere : b.count === 1).toBe(true);
    if (a.count === 1) expect((await del()).count).toBe(0);
  });
});
