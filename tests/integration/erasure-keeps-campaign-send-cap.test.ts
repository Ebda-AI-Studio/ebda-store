/**
 * Issue 2083 — account erasure must not shrink the rolling campaign send cap.
 *
 * `sentInLast24h` (the platform-wide send-reputation cap on the one shared
 * Resend key) counts `campaign_recipients` rows by `sentAt`. Erasure used to
 * HARD-delete every recipient row for the shopper's address, including rows
 * sent minutes ago, so each erasure handed the store back cap headroom.
 * Now the rows sent inside the window are anonymized (tombstone address, no
 * links) and still count; everything else is deleted as before.
 *
 * Mutation proof: in AuthService.eraseAccount, remove the in-window
 * anonymize loop → `sentInLast24h` drops from 1 to 0 and this goes red.
 *
 * Fixtures are per-CALL (retry-safe).
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { withRlsBypass } from '@force/database';
import { AuthService } from '../../apps/api/src/services/auth.service';
import { sentInLast24h } from '../../apps/api/src/services/campaign.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const PREFIX = 'erasecap-';
const created: { storeIds: string[]; userIds: string[] } = { storeIds: [], userIds: [] };

async function seed() {
  const uniq = crypto.randomUUID().slice(0, 12);
  const email = `${PREFIX}${uniq}@example.test`;
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `${PREFIX}owner-${uniq}@example.test`,
        passwordHash: 'x',
        role: 'store_admin',
        firstName: 'Cap',
        lastName: 'Owner',
      },
    });
    const store = await tx.store.create({
      data: {
        name: 'erasecap',
        slug: `${PREFIX}${uniq}`,
        template: 'modern',
        currency: 'KWD',
        ownerId: owner.id,
      },
    });
    const shopper = await tx.user.create({
      data: {
        email,
        passwordHash: 'x',
        role: 'customer',
        firstName: 'Shop',
        lastName: 'Per',
        storeId: store.id,
      },
    });
    created.storeIds.push(store.id);
    created.userIds.push(owner.id, shopper.id);

    const campaign = (name: string) =>
      tx.campaign.create({
        data: { storeId: store.id, name, subject: name, bodyHtml: '<p>x</p>', status: 'sent' },
      });
    const [recent, old, pending] = await Promise.all([
      campaign('recent'),
      campaign('old'),
      campaign('pending'),
    ]);
    const now = Date.now();
    await tx.campaignRecipient.createMany({
      data: [
        // Sent one hour ago — still counts against the cap.
        {
          campaignId: recent.id,
          storeId: store.id,
          email,
          locale: 'en',
          status: 'sent',
          sentAt: new Date(now - 60 * 60 * 1000),
          providerMessageId: 'msg-1',
        },
        // Sent two days ago — outside the window.
        {
          campaignId: old.id,
          storeId: store.id,
          email,
          locale: 'en',
          status: 'sent',
          sentAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        },
        // Never sent.
        { campaignId: pending.id, storeId: store.id, email, locale: 'en' },
      ],
    });
    return { storeId: store.id, shopperId: shopper.id, email };
  });
}

afterAll(async () => {
  if (!hasDb) return;
  await withRlsBypass(async tx => {
    await tx.campaignRecipient.deleteMany({ where: { storeId: { in: created.storeIds } } });
    await tx.campaign.deleteMany({ where: { storeId: { in: created.storeIds } } });
    await tx.user.deleteMany({ where: { storeId: { in: created.storeIds } } });
    await tx.store.deleteMany({ where: { id: { in: created.storeIds } } });
    await tx.user.deleteMany({ where: { id: { in: created.userIds } } });
  });
});

describe.skipIf(!hasDb)('eraseAccount keeps the campaign send cap intact (issue 2083)', () => {
  it('anonymizes in-window sent rows (still counted) and deletes the rest', async () => {
    const { storeId, shopperId, email } = await seed();
    expect(await withRlsBypass(() => sentInLast24h(storeId))).toBe(1);

    await AuthService.eraseAccount(shopperId);

    // The cap still sees the send.
    expect(await withRlsBypass(() => sentInLast24h(storeId))).toBe(1);

    const rows = await withRlsBypass(tx =>
      tx.campaignRecipient.findMany({
        where: { storeId },
        select: { id: true, email: true, providerMessageId: true, sentAt: true },
      })
    );
    // No row carries the address any more.
    expect(rows.some(r => r.email === email)).toBe(false);
    // Only the in-window sent row survives, as a tombstone.
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(`erased-${rows[0].id}@anonymized.local`);
    expect(rows[0].providerMessageId).toBeNull();
  });
});
