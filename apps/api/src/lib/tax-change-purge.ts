import { prisma } from '@ebda/database';
import { StorageService } from '../services/storage.service';

/**
 * A deleted store's VAT-registration change records (self-service A10, PR #774) are platform-global `system_settings` rows, not
 * tenant rows, so the store delete does not cascade to them: `tax.change.<storeId>` (the pending request, which names the PRIVATE
 * evidence object) and `tax.change-result.<storeId>` (the decision notice). Both carry a registration number and a legal name.
 *
 * Order: the evidence object FIRST, then the rows. A failure throws before the rows go, so the retry (and the P1 alert) can still
 * find the object key. A store with no such records is a no-op, so this is safe before #774 is merged.
 */
const CHANGE_PREFIX = 'tax.change.';
const RESULT_PREFIX = 'tax.change-result.';

export async function purgeTaxChangeRecords(
  storeId: string,
  deps: {
    readRow?: (key: string) => Promise<{ storageKey?: string } | null>;
    deleteObject?: (key: string) => Promise<void>;
    deleteRows?: (keys: string[]) => Promise<void>;
  } = {}
): Promise<{ object: boolean; rows: number }> {
  const readRow =
    deps.readRow ??
    (async (key: string) => {
      const row = await prisma.systemSetting.findUnique({
        where: { key },
        select: { value: true },
      });
      return row ? (row.value as { storageKey?: string }) : null;
    });
  const deleteObject = deps.deleteObject ?? ((key: string) => StorageService.deletePrivate(key));
  const deleteRows =
    deps.deleteRows ??
    (async (keys: string[]) => {
      await prisma.systemSetting.deleteMany({ where: { key: { in: keys } } });
    });
  const pending = await readRow(`${CHANGE_PREFIX}${storeId}`);
  let object = false;
  if (pending?.storageKey) {
    await deleteObject(pending.storageKey);
    object = true;
  }
  const keys = [`${CHANGE_PREFIX}${storeId}`, `${RESULT_PREFIX}${storeId}`];
  await deleteRows(keys);
  return { object, rows: keys.length };
}
