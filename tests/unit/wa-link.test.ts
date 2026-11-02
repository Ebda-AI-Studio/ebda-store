/**
 * The Ebda Chat link is server-owned and entitlement-gated: linked by the server writer AND
 * (the effective plan includes WhatsApp OR Ebda Chat reported an active package), otherwise NOT
 * linked (fail closed). Nothing a merchant can write (settings JSON) is consulted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  flags: vi.fn(),
  settingsRead: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    storeWhatsAppLink: {
      findUnique: h.find,
      upsert: h.upsert,
      updateMany: h.updateMany,
      create: h.create,
    },
    // a read of stores.settings would be a bug: the link must not come from there
    store: { findUnique: h.settingsRead },
  },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/plan-entitlements', () => ({ getAutomationFlags: h.flags }));

import {
  WhatsAppLinkService,
  canLinkWhatsApp,
  isWhatsAppLinked,
  packageEntitlementActive,
  whatsAppLinkState,
} from '@api/lib/wa/link';

const S = '11111111-1111-4111-8111-111111111111';
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);
const NO_PKG = {
  entitlementAutomation: false,
  entitlementStatus: null,
  entitlementValidUntil: null,
};
const PKG = {
  entitlementAutomation: true,
  entitlementStatus: 'active',
  entitlementValidUntil: FUTURE,
};

beforeEach(() => {
  h.find.mockReset().mockResolvedValue({ linked: true, ...NO_PKG });
  h.upsert.mockReset().mockResolvedValue({});
  h.updateMany.mockReset().mockResolvedValue({ count: 1 });
  h.create.mockReset().mockResolvedValue({});
  h.flags.mockReset().mockResolvedValue({ whatsappAutomation: true });
  h.settingsRead.mockReset().mockResolvedValue({ settings: { ebdaWhatsApp: { linked: true } } });
});

describe('packageEntitlementActive', () => {
  it('needs automation, trialing|active and a future validUntil', () => {
    expect(packageEntitlementActive(PKG)).toBe(true);
    expect(packageEntitlementActive({ ...PKG, entitlementStatus: 'trialing' })).toBe(true);
    for (const status of ['past_due', 'cancelled', 'expired', null]) {
      expect(packageEntitlementActive({ ...PKG, entitlementStatus: status })).toBe(false);
    }
    expect(packageEntitlementActive({ ...PKG, entitlementAutomation: false })).toBe(false);
    expect(packageEntitlementActive({ ...PKG, entitlementValidUntil: PAST })).toBe(false);
    expect(packageEntitlementActive({ ...PKG, entitlementValidUntil: null })).toBe(false);
  });
});

describe('isWhatsAppLinked', () => {
  it('linked by the server AND the plan includes WhatsApp', async () => {
    expect(await isWhatsAppLinked(S)).toBe(true);
  });

  it('linked, plan without WhatsApp, no package: not linked', async () => {
    h.flags.mockResolvedValue({ whatsappAutomation: false });
    expect(await isWhatsAppLinked(S)).toBe(false);
  });

  it('linked, plan without WhatsApp, but an ACTIVE package entitlement: linked (plan not even read)', async () => {
    h.flags.mockResolvedValue({ whatsappAutomation: false });
    h.find.mockResolvedValue({ linked: true, ...PKG });
    expect(await isWhatsAppLinked(S)).toBe(true);
    expect(h.flags).not.toHaveBeenCalled();
  });

  it.each([
    ['expired by date', { ...PKG, entitlementValidUntil: PAST }],
    ['past_due', { ...PKG, entitlementStatus: 'past_due' }],
    ['cancelled', { ...PKG, entitlementStatus: 'cancelled' }],
    ['automation off', { ...PKG, entitlementAutomation: false }],
  ])('a %s package does not entitle a store whose plan lacks WhatsApp', async (_n, pkg) => {
    h.flags.mockResolvedValue({ whatsappAutomation: false });
    h.find.mockResolvedValue({ linked: true, ...pkg });
    expect(await isWhatsAppLinked(S)).toBe(false);
  });

  it.each([
    ['no link row', null],
    ['unlinked (even with a package)', { linked: false, ...PKG }],
  ])('%s: not linked, and nothing else is consulted', async (_n, row) => {
    h.find.mockResolvedValue(row);
    expect(await isWhatsAppLinked(S)).toBe(false);
    expect(h.flags).not.toHaveBeenCalled();
  });

  it('an unknown plan decision fails closed', async () => {
    h.flags.mockResolvedValue(null);
    expect(await isWhatsAppLinked(S)).toBe(false);
  });

  it('a merchant-written settings.ebdaWhatsApp.linked=true is never consulted', async () => {
    h.find.mockResolvedValue(null);
    expect(await isWhatsAppLinked(S)).toBe(false);
    expect(h.settingsRead).not.toHaveBeenCalled();
  });
});

describe('canLinkWhatsApp / whatsAppLinkState', () => {
  it('connect needs the plan OR an active package', async () => {
    expect(await canLinkWhatsApp(S)).toBe(true);
    h.flags.mockResolvedValue({ whatsappAutomation: false });
    expect(await canLinkWhatsApp(S)).toBe(false);
    h.find.mockResolvedValue({ linked: false, ...PKG });
    expect(await canLinkWhatsApp(S)).toBe(true);
    h.find.mockResolvedValue(null);
    h.flags.mockResolvedValue(null);
    expect(await canLinkWhatsApp(S)).toBe(false);
  });
  it('the admin state shows linked, entitled and the effective result', async () => {
    h.flags.mockResolvedValue({ whatsappAutomation: false });
    expect(await whatsAppLinkState(S)).toEqual({ linked: true, entitled: false, active: false });
    h.find.mockResolvedValue({ linked: true, ...PKG });
    expect(await whatsAppLinkState(S)).toEqual({ linked: true, entitled: true, active: true });
  });
});

describe('WhatsAppLinkService.setLinked (the only link writer)', () => {
  it('upserts the row, idempotently', async () => {
    await WhatsAppLinkService.setLinked(S, true, 'owner-1');
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: S },
        create: expect.objectContaining({ storeId: S, linked: true, ownerUserId: 'owner-1' }),
        update: expect.objectContaining({ linked: true, ownerUserId: 'owner-1' }),
      })
    );
    await WhatsAppLinkService.setLinked(S, false);
    expect(h.upsert.mock.calls[1]![0].update).toMatchObject({ linked: false, linkedAt: null });
  });
});

describe('WhatsAppLinkService.applyEntitlement (monotonic version)', () => {
  const ev = (version: number) => ({
    packageId: 'pkg-1',
    automation: true,
    status: 'active',
    validUntil: FUTURE,
    version,
  });

  it('a newer version wins through ONE conditional update (version < new)', async () => {
    expect(await WhatsAppLinkService.applyEntitlement(S, ev(5))).toBe(true);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { storeId: S, entitlementVersion: { lt: 5 } },
      data: expect.objectContaining({ entitlementVersion: 5, entitlementStatus: 'active' }),
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('an older or equal version is ignored when a row exists', async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    h.find.mockResolvedValue({ entitlementVersion: 7 });
    expect(await WhatsAppLinkService.applyEntitlement(S, ev(7))).toBe(false);
    expect(await WhatsAppLinkService.applyEntitlement(S, ev(3))).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('an entitlement that arrives before the merchant links creates an UNLINKED row', async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    h.find.mockResolvedValue(null);
    expect(await WhatsAppLinkService.applyEntitlement(S, ev(1))).toBe(true);
    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ storeId: S, linked: false, entitlementVersion: 1 }),
    });
  });
});
