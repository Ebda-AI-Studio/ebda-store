import { prisma, runInTenantContext } from '@ebda/database';

/**
 * Has this store connected Ebda WhatsApp? (`settings.ebdaWhatsApp.linked`, set by the `store.linked`
 * / `store.unlinked` flow.) Until a store links, nothing is sent to WhatsApp for it: no event
 * leaves the Store, so a store that never opted in produces no traffic and no phone ever travels.
 */
export async function isWhatsAppLinked(storeId: string): Promise<boolean> {
  const store = await runInTenantContext(storeId, () =>
    prisma.store.findUnique({ where: { id: storeId }, select: { settings: true } })
  );
  const wa = (store?.settings as { ebdaWhatsApp?: { linked?: unknown } } | null)?.ebdaWhatsApp;
  return wa?.linked === true;
}
