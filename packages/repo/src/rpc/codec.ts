import { Prisma } from '@prisma/client';

/**
 * Wire format between the API Worker and a StoreDO (prisma-lite over RPC). Structured clone would turn a
 * Prisma.Decimal into a plain object and cannot carry our own tags, so results travel as a JSON string:
 *   Date -> {$t:'date',v:ms}   bigint -> {$t:'big',v:'123'}   Prisma.Decimal -> {$t:'dec',v:'12.50'}
 * A user key that starts with `$` (a Json column may hold anything) is escaped by one more `$`, so `$t` is never
 * ambiguous and a Json value round-trips exactly.
 */
type Tagged =
  | { $t: 'date'; v: number }
  | { $t: 'big'; v: string }
  | { $t: 'dec'; v: string }
  | { $t: 'pnull'; v: PrismaNullName };

/**
 * Prisma's null sentinels (`Prisma.DbNull` / `JsonNull` / `AnyNull`) are class instances: structured clone refuses them
 * (DataCloneError "Could not serialize object of type ...") and JSON turns them into `{}`. A product edit that cleared
 * its personalisation sent `Prisma.DbNull` to the StoreDO and 500ed every save on a DO store (2026-11-10, Ruling
 * PRISMA-NULL-RPC-1). They travel as `{ $t: 'pnull', v: 'DbNull' }` and are revived on the other side, where
 * prisma-lite already gives each its meaning (SQL NULL vs JSON null).
 */
type PrismaNullName = 'DbNull' | 'JsonNull' | 'AnyNull';
const prismaNullName = (v: unknown): PrismaNullName | null =>
  v === Prisma.DbNull
    ? 'DbNull'
    : v === Prisma.JsonNull
      ? 'JsonNull'
      : v === Prisma.AnyNull
        ? 'AnyNull'
        : null;
const prismaNullOf = (name: unknown): unknown =>
  name === 'DbNull'
    ? Prisma.DbNull
    : name === 'JsonNull'
      ? Prisma.JsonNull
      : name === 'AnyNull'
        ? Prisma.AnyNull
        : undefined;
const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * For the structured-clone transports (`query` / `mutate`): a copy of `value` with every Prisma null sentinel replaced by
 * its tag. Only plain objects and arrays are walked; everything else (Date, Decimal, ...) is passed through as before, and
 * a value with no sentinel is returned unchanged (same reference).
 */
export function wirePrismaNulls<T>(value: T): T {
  const name = prismaNullName(value);
  if (name) return { $t: 'pnull', v: name } as unknown as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(x => {
      const y = wirePrismaNulls(x);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : value) as T;
  }
  if (isPlain(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) {
      const y = wirePrismaNulls(x);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/** The DO side of `wirePrismaNulls`: every `{ $t: 'pnull' }` tag back to its Prisma sentinel. */
export function revivePrismaNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(x => {
      const y = revivePrismaNulls(x);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : value) as T;
  }
  if (isPlain(value)) {
    if (value.$t === 'pnull' && Object.keys(value).length === 2) {
      const s = prismaNullOf(value.v);
      if (s !== undefined) return s as T;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) {
      const y = revivePrismaNulls(x);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

const escapeKeys = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.startsWith('$') ? `$${k}` : k, v]));

export function encodeRpc(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, val: unknown) {
    const raw = this[key];
    if (raw instanceof Date) return { $t: 'date', v: raw.getTime() } satisfies Tagged;
    if (typeof raw === 'bigint') return { $t: 'big', v: raw.toString() } satisfies Tagged;
    if (Prisma.Decimal.isDecimal(raw)) return { $t: 'dec', v: String(raw) } satisfies Tagged;
    const pnull = prismaNullName(raw);
    if (pnull) return { $t: 'pnull', v: pnull } satisfies Tagged;
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
        if (t.$t === 'pnull') return prismaNullOf(t.v);
      }
      if (Object.keys(o).some(k => k.startsWith('$$')))
        return Object.fromEntries(
          Object.entries(o).map(([k, v]) => [k.startsWith('$$') ? k.slice(1) : k, v])
        );
    }
    return val;
  }) as T;
}
