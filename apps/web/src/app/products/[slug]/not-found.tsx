import StoreNotFound404 from '../../not-found';
import WholesaleProductFallback from './WholesaleProductFallback';

/**
 * Product 404. Identical to the app-wide 404 (same status, same body) except that a signed-in approved wholesale buyer is
 * shown a wholesale-only product that lives at this slug (see WholesaleProductFallback).
 */
export default async function ProductNotFound() {
  return <WholesaleProductFallback>{await StoreNotFound404()}</WholesaleProductFallback>;
}
