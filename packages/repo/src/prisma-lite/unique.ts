import type { Meta } from './types';

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const isDecimal = (v: unknown): boolean =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
  'd' in (v as object);
/** A plain scalar: what a unique field accepts (never an operator object, array or null). */
const isScalarValue = (v: unknown): boolean =>
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'bigint' ||
  typeof v === 'boolean' ||
  v instanceof Date ||
  isDecimal(v);

function safeKeys(o: Record<string, unknown>): string[] {
  const keys = Object.keys(o);
  for (const k of keys)
    if (UNSAFE.has(k)) throw new Error(`prisma-lite: refusing key ${JSON.stringify(k)}`);
  return keys;
}

/**
 * `{ storeId_slug: { storeId, slug } }` -> `{ storeId, slug }` (Prisma's compound-unique selector). Like Prisma it
 * REFUSES a selector that does not name a COMPLETE unique tuple whose every field is a plain value: a missing,
 * undefined, null or operator-object field must never degrade into "first row" (a cross-record / cross-tenant read
 * or write). Non-unique extra keys (filters such as `storeId`) are allowed and pass through unchanged.
 */
export function expandUnique(meta: Meta, model: string, where: unknown): Record<string, unknown> {
  if (!isPlain(where)) throw new Error('prisma-lite: a unique selector must be a plain object');
  const m = meta.models[model];
  const uniques = m.uniques.concat([m.pk]);
  const out: Record<string, unknown> = {};
  for (const k of safeKeys(where)) {
    const v = where[k];
    const hit = uniques.find(u => u.length > 1 && u.join('_') === k);
    if (hit) {
      if (!isPlain(v)) throw new Error(`prisma-lite: ${k} needs an object of its fields`);
      for (const kk of safeKeys(v)) out[kk] = v[kk];
    } else out[k] = where[k];
  }
  const complete = uniques.some(
    u => u.length > 0 && u.every(f => own(out, f) && isScalarValue(out[f]))
  );
  if (!complete)
    throw new Error(
      `prisma-lite: a unique selector on ${model} needs every field of one unique key, each a plain non-null value`
    );
  return out;
}
