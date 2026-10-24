import { Prisma } from '@prisma/client';
import type { ScalarField } from './types';

/** JS value -> SQLite bind value (the inverse of `decode`). */
/** `exact`: filter operands must be representable without rounding (a rounded bound changes which rows match). */
export function encode(f: ScalarField, v: unknown, exact = false): unknown {
  if (v === null || v === undefined) return null;
  if (f.list) return JSON.stringify(v);
  if (f.kind === 'enum') return v;
  switch (f.type) {
    case 'Boolean':
      // strict: a forwarded query-string 'false' must not become true
      if (typeof v !== 'boolean') throw new Error('prisma-lite: a Boolean field needs a boolean');
      return v ? 1 : 0;
    case 'DateTime': {
      const t =
        v instanceof Date
          ? v.getTime()
          : typeof v === 'string' || typeof v === 'number'
            ? new Date(v).getTime()
            : NaN;
      if (!Number.isFinite(t)) throw new Error('prisma-lite: invalid DateTime');
      return t;
    }
    case 'Json':
      return JSON.stringify(v);
    case 'Decimal': {
      const d = v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v as string | number);
      const scale = f.scale ?? 0;
      if (exact && d.decimalPlaces() > scale)
        throw new Error(
          `prisma-lite: a Decimal(${scale}) filter operand ${d.toString()} cannot be compared without rounding`
        );
      // writes round half away from zero, like Postgres numeric
      const scaled = d
        .toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP)
        .mul(new Prisma.Decimal(10).pow(scale))
        .toNumber();
      if (!Number.isSafeInteger(scaled))
        throw new Error(
          'prisma-lite: Decimal value exceeds the exact integer range of the scaled representation'
        );
      return scaled;
    }
    case 'BigInt': {
      const n = typeof v === 'bigint' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isSafeInteger(n))
        throw new Error('prisma-lite: BigInt value outside the safe integer range');
      return n;
    }
    default:
      return v;
  }
}

/** SQLite column value -> the JS value Prisma would have returned. */
export function decode(f: ScalarField, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (f.list) return JSON.parse(v as string);
  if (f.kind === 'enum') return v;
  switch (f.type) {
    case 'Boolean':
      return v === 1 || v === true;
    case 'DateTime':
      return new Date(v as number);
    case 'Json':
      return JSON.parse(v as string);
    case 'Decimal':
      return new Prisma.Decimal(v as number).div(new Prisma.Decimal(10).pow(f.scale ?? 0));
    case 'BigInt':
      return BigInt(v as number);
    default:
      return v;
  }
}
