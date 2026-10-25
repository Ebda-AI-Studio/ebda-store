/**
 * The Ebda WhatsApp link is server-owned and entitlement-gated: linked by the server writer AND the
 * store's effective plan includes WhatsApp, otherwise NOT linked (fail closed). Nothing a merchant
 * can write (settings JSON) is consulted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  upsert: vi.fn(),
  flags: vi.fn(),
  settingsRead: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    storeWhatsAppLink: { findUnique: h.find, upsert: h.upsert },
    // a read of stores.settings would be a bug: the link must not come from there
    store: { findUnique: h.settingsRead },
  },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/plan-entitlements', () => ({ getAutomationFlags: h.flags }));

import { WhatsAppLinkService, isWhatsAppLinked } from '@api/lib/wa/link';

const S = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  h.find.mockReset().mockResolvedValue({ linked: true });
  h.upsert.mockReset().mockResolvedValue({});
  h.flags.mockReset().mockResolvedValue({ whatsappAutomation: true });
  h.settingsRead.mockReset().mockResolvedValue({ settings: { ebdaWhatsApp: { linked: true } } });
});

describe('isWhatsAppLinked', () => {
  it('linked by the server AND the plan includes WhatsApp', async () => {
    expect(await isWhatsAppLinked(S)).toBe(true);
  });

  it('linked by the consumer but the plan has no WhatsApp: not linked', async () => {
    h.flags.mockResolvedValue({ whatsappAutomation: false });
    expect(await isWhatsAppLinked(S)).toBe(false);
  });

  it.each([
    ['no link row', null],
    ['unlinked', { linked: false }],
  ])('%s: not linked, and the plan is not even consulted', async (_n, row) => {
    h.find.mockResolvedValue(row);
    expect(await isWhatsAppLinked(S)).toBe(false);
    expect(h.flags).not.toHaveBeenCalled();
  });

  it('an unknown store / plan decision fails closed', async () => {
    h.flags.mockResolvedValue(null);
    expect(await isWhatsAppLinked(S)).toBe(false);
  });

  it('a merchant-written settings.ebdaWhatsApp.linked=true is never consulted', async () => {
    h.find.mockResolvedValue(null);
    expect(await isWhatsAppLinked(S)).toBe(false);
    expect(h.settingsRead).not.toHaveBeenCalled();
  });
});

describe('WhatsAppLinkService.setLinked (the only writer)', () => {
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
