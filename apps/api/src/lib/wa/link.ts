import { readStoreDb, runInStoreCtx } from '../jobs/store-db';
import { storeWriter } from '../repo-factory';
import { getAutomationFlags } from '../../services/plan-entitlements';

/**
 * Is Ebda Chat linked AND entitled for this store? Both must hold; anything unknown fails closed.
 *
 *  - Link state: the server-only `store_whatsapp_links` row, written ONLY by `WhatsAppLinkService`
 *    (the connect / disconnect route). It is NOT a flag in `stores.settings`, which the store owner
 *    writes through the update routes (reserved key, see SERVER_OWNED_SETTINGS_KEYS).
 *  - Entitlement (contract + Ebda Chat session, 2026-10-25): the store's EFFECTIVE plan includes
 *    the package (`whatsappAutomation`) OR Ebda Chat reported an active entitlement
 *    (`whatsapp.entitlement_changed`: automation on, status trialing|active, validUntil in the
 *    future), stored on the same server-only row. A downgrade, a lapsed subscription or an expired
 *    package stops all events at once, with no event needed.
 *
 * No link or no entitlement: no event leaves the Store and no phone travels.
 */
export interface EntitlementRow {
  entitlementAutomation: boolean;
  entitlementStatus: string | null;
  entitlementValidUntil: Date | null;
}

export function packageEntitlementActive(row: EntitlementRow, now: Date = new Date()): boolean {
  return (
    row.entitlementAutomation === true &&
    (row.entitlementStatus === 'trialing' || row.entitlementStatus === 'active') &&
    row.entitlementValidUntil !== null &&
    row.entitlementValidUntil.getTime() > now.getTime()
  );
}

const linkSelect = {
  linked: true,
  entitlementAutomation: true,
  entitlementStatus: true,
  entitlementValidUntil: true,
} as const;

async function entitled(
  storeId: string,
  row: EntitlementRow
): Promise<{ plan: boolean; pkg: boolean }> {
  const flags = await getAutomationFlags(storeId);
  return { plan: flags?.whatsappAutomation === true, pkg: packageEntitlementActive(row) };
}

export async function isWhatsAppLinked(storeId: string): Promise<boolean> {
  const link = await readStoreDb(storeId, db =>
    db.storeWhatsAppLink.findUnique({ where: { storeId }, select: linkSelect })
  );
  if (link?.linked !== true) return false;
  // The package entitlement alone is enough: do not even read the plan in that case.
  if (packageEntitlementActive(link)) return true;
  return (await entitled(storeId, link)).plan;
}

/** Does Ebda Chat know this store (a link row exists: linked now, unlinked, or entitlement only)? */
export async function hasWhatsAppLinkRow(storeId: string): Promise<boolean> {
  const row = await readStoreDb(storeId, db =>
    db.storeWhatsAppLink.findUnique({ where: { storeId }, select: { storeId: true } })
  );
  return row !== null;
}

/** What Store admin shows: the stored link and whether the plan or a package entitles it. */
export async function whatsAppLinkState(
  storeId: string
): Promise<{ linked: boolean; entitled: boolean; active: boolean }> {
  const link = await readStoreDb(storeId, db =>
    db.storeWhatsAppLink.findUnique({ where: { storeId }, select: linkSelect })
  );
  const linked = link?.linked === true;
  const e = await entitled(
    storeId,
    link ?? { entitlementAutomation: false, entitlementStatus: null, entitlementValidUntil: null }
  );
  const isEntitled = e.plan || e.pkg;
  return { linked, entitled: isEntitled, active: linked && isEntitled };
}

/**
 * Can this store be linked right now (the connect route)? The plan includes WhatsApp, or Ebda
 * WhatsApp reported an active package for it. Fail closed.
 */
export async function canLinkWhatsApp(storeId: string): Promise<boolean> {
  const link = await readStoreDb(storeId, db =>
    db.storeWhatsAppLink.findUnique({ where: { storeId }, select: linkSelect })
  );
  const e = await entitled(
    storeId,
    link ?? { entitlementAutomation: false, entitlementStatus: null, entitlementValidUntil: null }
  );
  return e.plan || e.pkg;
}

/**
 * The ONE writer of the link state and the stored entitlement. Called from the connect /
 * disconnect route and the `ebda-store-events` consumer, never from a generic update route.
 * Idempotent.
 */
export const WhatsAppLinkService = {
  async setLinked(storeId: string, linked: boolean, ownerUserId?: string): Promise<void> {
    await runInStoreCtx(storeId, async () =>
      (await storeWriter(storeId)).storeWhatsAppLink.upsert({
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

  /**
   * Apply `whatsapp.entitlement_changed`. `version` only goes up: an event whose version is not
   * newer than the stored one is ignored (returns false). The compare-and-set is ONE conditional
   * UPDATE (or an insert that loses to a concurrent one), so two racing events cannot both win.
   */
  async applyEntitlement(
    storeId: string,
    e: {
      packageId: string;
      automation: boolean;
      status: string;
      validUntil: Date;
      version: number;
    }
  ): Promise<boolean> {
    return runInStoreCtx(storeId, async () => {
      const w = await storeWriter(storeId);
      const data = {
        entitlementVersion: e.version,
        entitlementPackageId: e.packageId,
        entitlementAutomation: e.automation,
        entitlementStatus: e.status,
        entitlementValidUntil: e.validUntil,
      };
      const updated = await w.storeWhatsAppLink.updateMany({
        where: { storeId, entitlementVersion: { lt: e.version } },
        data,
      });
      if (updated.count > 0) return true;
      const existing = await w.storeWhatsAppLink.findUnique({
        where: { storeId },
        select: { entitlementVersion: true },
      });
      if (existing) return false; // a newer or equal version is already stored
      // No row yet (the entitlement arrives before the merchant links): create it unlinked.
      await w.storeWhatsAppLink.create({ data: { storeId, linked: false, ...data } });
      return true;
    });
  },
};
