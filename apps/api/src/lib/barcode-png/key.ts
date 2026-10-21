import { createHmac } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^stores\/[0-9a-f-]{36}\/barcodes\/[0-9a-f]{32}\.png$/;

/**
 * R2 key of a rendered email barcode: `stores/<storeId>/barcodes/<hmac>.png`.
 * Store-scoped (offboarding's `deleteByPrefix('stores/<id>/')` reclaims it) and
 * non-guessable: the name is a keyed HMAC of (store, kind, number, shape), so a
 * known order number cannot be turned into someone else's image URL. The image
 * itself holds only bars, and neither the key nor the URL carries PII.
 * Deterministic: re-rendering the same barcode overwrites the same object.
 */
export function barcodeObjectKey(
  secret: string,
  storeId: string,
  kind: string,
  number: string,
  shape: string
): string {
  if (!UUID.test(storeId)) throw new Error('barcode key: storeId must be a uuid');
  const h = createHmac('sha256', secret)
    .update(`barcode-png:v1:${storeId}:${kind}:${number}:${shape}`)
    .digest('hex')
    .slice(0, 32);
  return `stores/${storeId}/barcodes/${h}.png`;
}

export const isBarcodeObjectKey = (key: string): boolean => KEY.test(key);
