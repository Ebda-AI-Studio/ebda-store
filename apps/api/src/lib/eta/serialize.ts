import { createHash } from 'node:crypto';

/**
 * ETA document serialization and receipt UUID.
 *
 * Source: https://sdk.invoicing.eta.gov.eg/document-serialization-approach/ (read 2026-10-26):
 *  - recurse from the document root; property names become culture-invariant UPPERCASE;
 *  - simple values are taken VERBATIM ("0.0" stays "0.0") and wrapped in double quotes;
 *  - objects are not quoted, they are recursed into;
 *  - JSON arrays: the array name once, then the name again before each element
 *    (`"TAXABLEITEMS""TAXABLEITEMS"<item1>"TAXABLEITEMS"<item2>`);
 *  - JSON needs no quote escaping (a `"` is already `\"` in the JSON text).
 *  Receipt UUID (https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/): serialize the receipt with
 *  its own `uuid` EMPTY, SHA-256 it, hex-encode (64 chars).
 *
 * Verbatim: numbers are rendered with `String(n)`, the same text `JSON.stringify` puts on the wire,
 * so the hashed text and the submitted text can never disagree. The sdk page does not publish the
 * exact handling of an empty string value; we emit `"UUID"""`. UNVERIFIED against the PreProd
 * Postman collection - the PreProd gate in the plan (P2 exit) is what settles it.
 */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function simple(v: string | number | boolean | null): string {
  return `"${v === null ? '' : String(v)}"`;
}

export function serializeEtaValue(value: Json): string {
  if (value === null || typeof value !== 'object') return simple(value as string | number);
  if (Array.isArray(value))
    throw new Error('serializeEtaValue: arrays are serialized under a name');
  let out = '';
  for (const [name, v] of Object.entries(value)) {
    const key = `"${name.toUpperCase()}"`;
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      out += key;
      for (const el of v) out += key + serializeEtaValue(el);
    } else {
      out += key + serializeEtaValue(v);
    }
  }
  return out;
}

export function receiptUuid(
  receiptWithoutUuid: { header: { uuid: string } } & Record<string, Json>
): string {
  const clone = JSON.parse(JSON.stringify(receiptWithoutUuid)) as typeof receiptWithoutUuid;
  clone.header.uuid = '';
  return createHash('sha256')
    .update(serializeEtaValue(clone as unknown as Json), 'utf8')
    .digest('hex');
}
