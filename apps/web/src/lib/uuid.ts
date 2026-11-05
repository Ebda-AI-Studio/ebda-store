/**
 * A v4 UUID that also works where `crypto.randomUUID` does not exist: browsers expose it only in a
 * secure context (https or localhost), so a storefront opened over plain http on a LAN or test
 * host name (`*.test`) would throw at "Place order" with "crypto.randomUUID is not a function".
 * `getRandomValues` has no such restriction.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
