/** PDPL access/portability: the shopper's own Customer Intelligence rows (R2 `ebda-ci`), by buyer key. */
import { cfBindings } from '../../cf/bindings';
import { ciSurface } from '../../cf/erasure/surfaces';
import type { R2BucketLike } from '../../cf/erasure/types';

export async function exportCiOutcomes(
  buyerKeys: string[],
  bucket: R2BucketLike | undefined = cfBindings()?.CI_BUCKET as unknown as R2BucketLike | undefined
): Promise<unknown[]> {
  if (buyerKeys.length === 0 || !bucket) return [];
  const rows: unknown[] = [];
  for (const buyerKey of new Set(buyerKeys)) {
    const part = await ciSurface(bucket).exportSubject({
      kind: 'customer',
      requestId: 'export',
      buyerKey,
    });
    for (const line of part.ndjson.split('\n')) if (line) rows.push(JSON.parse(line));
  }
  return rows;
}
