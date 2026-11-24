import logger from './logger';

/** A field that lives only in D1 is not served by the DO compare-and-set: say so (ids and field names only, never values). */
export function warnD1OnlySkips(storeId: string, fields: string[] | undefined, job?: string): void {
  for (const field of fields ?? [])
    logger.warn(
      { storeId, field, job },
      '[store-cas] field exists only in D1; not written by the DO compare-and-set'
    );
}
