/**
 * Issue #831 class sweep — admin apiGet/apiPost/apiPut/apiPatch/apiDelete
 * double-unwrap.
 *
 * `apiRequest` (apps/admin/src/lib/api.ts) already unwraps the server's
 * `{ success, data, error }` envelope ONE level: it returns
 * `{ data: json.data as T, error }`. So when a server route does
 * `res.json({ data: X })`, the caller's destructured `data` IS `X` already.
 * A caller that types the call as `apiGet<{ data: X }>` (or a named
 * interface shaped `{ data: X }`) and then reads `data?.data` / `data.data`
 * gets `undefined` and silently renders nothing.
 *
 * Confirmed live instance (the reported bug): the stock/backorders page
 * read `data?.data` against `GET /stores/:storeId/backorders`, which returns
 * `res.json({ data })` with `data` = the array — the page was always empty.
 * A full sweep of apps/admin/src found the SAME shape in 10 more admin
 * pages (fx-rates, bank-reconciliation x3, purchase-orders x3, suppliers
 * x2, ai-usage) — all fixed alongside this file.
 *
 * This is a STATIC scan, not a schema/route test, because the bug is
 * entirely in the ADMIN CALLER — the server routes for every fixed site
 * were already correct. A schema test proves nothing about this defect.
 *
 * The scan flags any non-test .ts/.tsx file under apps/admin/src with an
 * api* call that BOTH:
 *   1. Is typed with a `{ data: ... }`-shaped argument — either an inline
 *      literal or a named interface/type declared in the same file with a
 *      top-level `data` field, AND
 *   2. Has `data?.data` or `data.data` (the second, spurious unwrap) within
 *      a short window AFTER that specific call — not merely anywhere in the
 *      file. A whole-file check false-positives on large files that reuse
 *      the identifier `data` for an unrelated raw-fetch envelope elsewhere
 *      (page-builder/page.tsx: a correctly-typed apiGet<{ data?: ... }>
 *      call, and ~350 lines away an unrelated `const data = await
 *      res.json()` from a raw apiFetch upload, whose `data.data.url` is a
 *      correct FIRST unwrap of a different object).
 *
 * A handful of routes genuinely DOUBLE-wrap on the server (e.g.
 * `res.json({ success: true, data: { data: items, meta } })` in
 * smart-layer.routes.ts) — for those sites `data.data` is CORRECT, and
 * they're named in LEGITIMATE_DOUBLE_WRAP with the server evidence that
 * makes them so. Any new name added to that allowlist must cite the actual
 * `res.json(...)` call it was checked against.
 *
 * Mutation-proof: temporarily restoring the old
 * `setLines(data?.data ?? [])` line in stock/backorders/page.tsx and
 * running this file turns the "no violations" assertion red (captured in
 * the fix commit / PR description). Byte-identical restore verified via
 * `git diff` after.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ADMIN_SRC = path.resolve(__dirname, '../../../src');

// ─── File discovery ───────────────────────────────────────────────────────

function collectSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// ─── Detection ────────────────────────────────────────────────────────────

// No `.` in this pattern, so the `s` (dotAll) flag isn't needed — `[^(]`
// already matches newlines regardless, and `s` isn't available at this
// tsconfig's target.
const API_CALL_RE = /\bapi(?:Get|Post|Put|Patch|Delete)\s*<\s*([^(]*?)>\s*\(/g;
const DOUBLE_READ_RE = /\bdata\??\.data\b/;

// How far past a flagged api* call to look for the double-read. A whole-file
// check false-positives on large files that use the identifier `data` for
// unrelated raw-fetch envelopes elsewhere (e.g. page-builder/page.tsx has
// BOTH a safely-typed apiGet<{ data?: ... }> call AND, ~350 lines away, an
// unrelated `const data = await res.json()` from a raw apiFetch upload,
// whose `data.data.url` is a correct FIRST unwrap of a different object).
// A proximity window scopes the double-read check to the call it actually
// belongs to.
const PROXIMITY_CHARS = 600;

/** True when `data` (or `data?`) is declared as a field at the TOP level of
 *  a `{ ... }` body — ignores `data:`/`data?:` that appear nested inside a
 *  sub-object (brace-depth aware, unlike a plain regex). */
function hasTopLevelDataField(body: string): boolean {
  let depth = 0;
  const re = /\{|\}|\bdata\??\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[0] === '{') depth++;
    else if (m[0] === '}') depth--;
    else if (depth === 0) return true;
  }
  return false;
}

/** Extracts `interface Name { ... }` / `type Name = { ... }` bodies,
 *  brace-matched (not regex-truncated at the first nested `}`). */
function extractNamedTypeBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const declRe = /(?:interface|type)\s+(\w+)\s*(?:<[^>]*>)?\s*=?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) {
    const name = m[1];
    const start = declRe.lastIndex; // just after the opening '{'
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    bodies.set(name, src.slice(start, i - 1));
  }
  return bodies;
}

/**
 * True when the file calls an api* helper with a `{ data: ... }`-shaped
 * type argument (inline, or a named type declared in the same file) AND
 * the double-read (`data?.data` / `data.data`) shows up within
 * PROXIMITY_CHARS of THAT SPECIFIC call — not merely anywhere in the file.
 */
function hasProximateDoubleUnwrap(src: string): boolean {
  const namedDataTypes = new Set<string>();
  for (const [name, body] of extractNamedTypeBodies(src)) {
    if (hasTopLevelDataField(body)) namedDataTypes.add(name);
  }

  let m: RegExpExecArray | null;
  API_CALL_RE.lastIndex = 0;
  while ((m = API_CALL_RE.exec(src))) {
    const typeArg = m[1].trim();
    const isDataShaped =
      (/^\{/.test(typeArg) && hasTopLevelDataField(typeArg.slice(1, -1))) ||
      namedDataTypes.has(typeArg.replace(/\[\]$/, ''));
    if (!isDataShaped) continue;

    const windowEnd = Math.min(src.length, API_CALL_RE.lastIndex + PROXIMITY_CHARS);
    const window = src.slice(API_CALL_RE.lastIndex, windowEnd);
    if (DOUBLE_READ_RE.test(window)) return true;
  }
  return false;
}

// ─── Allowlists ─────────────────────────────────────────────────────────────

/**
 * Sites where the SERVER genuinely double-wraps (`{ success, data: { data,
 * meta } }` or the tolerant-dual-shape pattern below), so `data.data` is the
 * correct read. Each entry cites the route file:line evidence checked.
 */
const LEGITIMATE_DOUBLE_WRAP: Record<string, string> = {
  'app/stores/[id]/customers/page.tsx':
    'GET /stores/:storeId/customers (customers.routes.ts) double-wraps on ' +
    'purpose — its own comment: "the admin apiGet helper unwraps one data ' +
    'layer, so the inner { data, meta } is what reaches the page."',
  'app/stores/[id]/finance/anomalies/page.tsx':
    'GET /:storeId/finance/anomalies (smart-layer.routes.ts) responds ' +
    'res.json({ success: true, data: { data: items, meta: pageMeta(...) } }).',
  'app/stores/[id]/stock/reorder/page.tsx':
    'GET /:storeId/stock/reorder-suggestions (smart-layer.routes.ts) responds ' +
    'res.json({ success: true, data: { data: items, meta: pageMeta(...) } }).',
  'app/stores/[id]/stock/deadstock/page.tsx':
    'GET /:storeId/stock/deadstock-flags (smart-layer.routes.ts) responds ' +
    'res.json({ success: true, data: { data: items, meta: pageMeta(...) } }).',
  'app/stores/[id]/stock/dashboard/page.tsx':
    'Reads data.data/data.meta only for the reorder-suggestions and ' +
    'deadstock-flags summary calls above — same double-wrapped routes.',
  'app/stores/[id]/stock/inventory/page.tsx':
    'Reads data.data only for the reorder-suggestions and deadstock-flags ' +
    'productId-set calls — same double-wrapped routes.',
  'app/stores/[id]/affiliates/page.tsx':
    'Defensively unwraps EITHER shape via `data.x ?? data.data?.x` — the ' +
    'live server (affiliate.routes.ts) single-wraps ' +
    '(`{ success: true, data: { stats } }` / `{ config }` / result), so the ' +
    'first branch always wins; the `.data.x` fallback is dead-but-harmless ' +
    'tolerance for a legacy shape, not the active bug pattern (no bare ' +
    '`data?.data` — every read is `data.data?.x ?? ...`).',
};

// ─── The gate ─────────────────────────────────────────────────────────────

describe('admin apiGet/apiPost double-unwrap — class sweep (issue #831)', () => {
  const files = collectSourceFiles(ADMIN_SRC, []);
  const rel = (f: string) => path.relative(ADMIN_SRC, f).split(path.sep).join('/');

  const violations = files
    .filter(f => !(rel(f) in LEGITIMATE_DOUBLE_WRAP))
    .filter(f => hasProximateDoubleUnwrap(readFileSync(f, 'utf-8')))
    .map(rel);

  it('no unallowlisted admin file both types an api* call `{ data: ... }` and reads `data.data` near that call', () => {
    expect(violations).toEqual([]);
  });

  it('every allowlisted path still exists (a rename must not silently widen the gate)', () => {
    // Guards against the allowlist silently going stale (e.g. a rename)
    // by asserting every allowlisted path still exists under apps/admin/src.
    for (const relPath of Object.keys(LEGITIMATE_DOUBLE_WRAP)) {
      const abs = path.join(ADMIN_SRC, relPath);
      expect(files.includes(abs), `allowlisted path missing: ${relPath}`).toBe(true);
    }
  });
});
