/** PDPL access/portability: the shopper's OWN Customer Intelligence rows (their orders, this store). */
import { cfBindings } from '../../cf/bindings';
import { exportCiForOrders, type CiBucket, type CiOrderScope } from './erase';

export async function exportCiOutcomes(
  scope: CiOrderScope,
  bucket: CiBucket | undefined = cfBindings()?.CI_BUCKET as unknown as CiBucket | undefined
): Promise<unknown[]> {
  if (scope.orderIds.length === 0 || scope.buyerKeys.length === 0 || !bucket) return [];
  return exportCiForOrders(bucket, scope);
}
