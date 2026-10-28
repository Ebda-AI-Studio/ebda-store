import { Prisma } from '@prisma/client';

/**
 * Wire format between the API Worker and a StoreDO (prisma-lite over RPC). Structured clone would turn a
 * Prisma.Decimal into a plain object and cannot carry our own tags, so results travel as a JSON string:
 *   Date -> {$t:'date',v:ms}   bigint -> {$t:'big',v:'123'}   Prisma.Decimal -> {$t:'dec',v:'12.50'}
 * A user key that starts with `$` (a Json column may hold anything) is escaped by one more `$`, so `$t` is never
 * ambiguous and a Json value round-trips exactly.
 */
type Tagged = { $t: 'date'; v: number } | { $t: 'big'; v: string } | { $t: 'dec'; v: string };

const escapeKeys = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.startsWith('$') ? `$${k}` : k, v]));

export function encodeRpc(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, val: unknown) {
    const raw = this[key];
    if (raw instanceof Date) return { $t: 'date', v: raw.getTime() } satisfies Tagged;
    if (typeof raw === 'bigint') return { $t: 'big', v: raw.toString() } satisfies Tagged;
    if (Prisma.Decimal.isDecimal(raw)) return { $t: 'dec', v: String(raw) } satisfies Tagged;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      if (Object.keys(o).some(k => k.startsWith('$'))) return escapeKeys(o);
    }
    return val;
  });
}

export function decodeRpc<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      if (typeof o.$t === 'string') {
        const t = o as unknown as Tagged;
        if (t.$t === 'date') return new Date(t.v);
        if (t.$t === 'big') return BigInt(t.v);
        if (t.$t === 'dec') return new Prisma.Decimal(t.v);
      }
      if (Object.keys(o).some(k => k.startsWith('$$')))
        return Object.fromEntries(
          Object.entries(o).map(([k, v]) => [k.startsWith('$$') ? k.slice(1) : k, v])
        );
    }
    return val;
  }) as T;
}
