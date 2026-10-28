// Canonical row form shared by BOTH sides of a migration check (Node reading Postgres, the StoreDO and D1
// reading SQLite). A table is "equal" when its row count and its digest match; the digest covers EVERY
// migrated column, not just id|updated_at, so a transform bug in any column cannot hide.
//
//   value  : null | string | finite number | bigint  ->  null | string   (numbers via String(), exact for
//            safe integers and for doubles; booleans must already be 0/1)
//   row    : JSON of [[col, value], ...] sorted by col name
//   table  : sha256 over lines  `${pkKey}\t${sha256(row)}\n`  sorted by pkKey (plain code-unit order)
//
// Pure ES module, no Node-only imports (crypto.subtle exists in Node 20+ and in workerd).

export const PK_SEP = '\u0001';

/** @param {unknown} v */
export function canonValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number ${v}`);
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean')
    throw new Error('boolean reached canonValue; transform it to 0/1 first');
  if (typeof v === 'string') return v;
  throw new Error(`cannot canonicalise a ${typeof v}`);
}

/**
 * @param {string[]} columns the migrated columns (any order)
 * @param {unknown[]} values aligned with `columns`
 */
export function canonRow(columns, values) {
  const pairs = columns.map((c, i) => [c, canonValue(values[i])]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pairs);
}

/** @param {string} s */
export async function sha256Hex(s) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Accumulates a table digest row by row; order of `add` calls does not matter. */
export class TableDigest {
  constructor() {
    /** @type {string[]} */ this.lines = [];
  }
  /**
   * @param {string[]} columns
   * @param {unknown[]} values
   * @param {string[]} pk primary-key column names
   */
  async add(columns, values, pk) {
    const idx = new Map(columns.map((c, i) => [c, i]));
    const key = pk
      .map(c => {
        if (!idx.has(c)) throw new Error(`pk column ${c} is not among the migrated columns`);
        return canonValue(values[idx.get(c)]);
      })
      .join(PK_SEP);
    this.lines.push(`${key}\t${await sha256Hex(canonRow(columns, values))}\n`);
  }
  get count() {
    return this.lines.length;
  }
  async finish() {
    this.lines.sort();
    return { count: this.lines.length, digest: await sha256Hex(this.lines.join('')) };
  }
}
