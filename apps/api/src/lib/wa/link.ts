import { prisma, runInTenantContext } from '@ebda/database';
import { getAutomationFlags } from '../../services/plan-entitlements';

/**
 * Is Ebda WhatsApp linked AND entitled for this store? Both must hold; anything unknown fails closed.
 *
 *  - Link state: the server-only `store_whatsapp_links` row, written ONLY by `WhatsAppLinkService`
 *    (the `store.linked` / `store.unlinked` path). It is NOT a flag in `stores.settings`, which the
 *    store owner writes through the update routes (reserved key, see SERVER_OWNED_SETTINGS_KEYS).
 *  - Entitlement: the store's EFFECTIVE plan includes the Ebda WhatsApp package
 *    (`whatsappAutomation`, contract section 1). A downgrade, a lapsed subscription or an unknown
 *    store stops all events at once, with no event needed.
 *
 * No link or no entitlement: no event leaves the Store and no phone travels.
 */
export async function isWhatsAppLinked(storeId: string): Promise<boolean> {
  const link = await runInTenantContext(storeId, () =>
    prisma.storeWhatsAppLink.findUnique({ where: { storeId }, select: { linked: true } })
  );
  if (link?.linked !== true) return false;
  const flags = await getAutomationFlags(storeId);
  return flags?.whatsappAutomation === true;
}

/**
 * The ONE writer of the link state. Called from the connect / disconnect flow behind the
 * `store.linked` / `store.unlinked` events, never from a generic update route. Idempotent.
 */
export const WhatsAppLinkService = {
  async setLinked(storeId: string, linked: boolean, ownerUserId?: string): Promise<void> {
    await runInTenantContext(storeId, () =>
      prisma.storeWhatsAppLink.upsert({
        where: { storeId },
        create: {
          storeId,
          linked,
          ownerUserId: ownerUserId ?? null,
          linkedAt: linked ? new Date() : null,
        },
        update: {
          linked,
          ...(ownerUserId ? { ownerUserId } : {}),
          linkedAt: linked ? new Date() : null,
        },
      })
    );
  },
};

/** What Store admin shows: the stored link and whether the plan includes the package. */
export async function whatsAppLinkState(
  storeId: string
): Promise<{ linked: boolean; entitled: boolean; active: boolean }> {
  const link = await runInTenantContext(storeId, () =>
    prisma.storeWhatsAppLink.findUnique({ where: { storeId }, select: { linked: true } })
  );
  const flags = await getAutomationFlags(storeId);
  const linked = link?.linked === true;
  const entitled = flags?.whatsappAutomation === true;
  return { linked, entitled, active: linked && entitled };
}
