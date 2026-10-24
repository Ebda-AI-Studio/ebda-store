import { Prisma } from '@prisma/client';
import type { ScalarField } from './types';

/** JS value -> SQLite bind value (the inverse of `decode`). */
export function encode(f: ScalarField, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (f.list) return JSON.stringify(v);
  if (f.kind === 'enum') return v;
  switch (f.type) {
    case 'Boolean':
      return v ? 1 : 0;
    case 'DateTime':
      return v instanceof Date ? v.getTime() : new Date(v as string).getTime();
    case 'Json':
      return JSON.stringify(v);
    case 'Decimal': {
      const d = v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v as string | number);
      return d
        .mul(new Prisma.Decimal(10).pow(f.scale ?? 0))
        .toDecimalPlaces(0)
        .toNumber();
    }
    case 'BigInt':
      return typeof v === 'bigint' ? Number(v) : v;
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
