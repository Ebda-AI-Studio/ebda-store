/**
 * 2026-11-06 P1: `stock-low-stock-alert-cron` selected the `owner` RELATION from `db.store`; the StoreDO record serves scalars only,
 * so every DO store's alarm run failed with STORE_RECORD_REFUSED. Class guard: every `store.findUnique|findFirst({ select })` in
 * code that runs as a job (inngest functions, lib/jobs, inventory/accounting services) names only fields the DO store record knows
 * (`META.models.Store`), and the one relation it may name is `owner` (repo-factory serves it from the account service).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { META } from '../../packages/repo/test/diff-harness';

const API = path.resolve(__dirname, '../../apps/api/src');
const SCOPES = ['lib/inngest/functions', 'lib/jobs', 'services/inventory', 'services/accounting'];
const SERVED_RELATIONS = new Set(['owner']);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' ? [] : files(p);
    return /\.ts$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [p] : [];
  });
}

/** Text of the balanced bracket group starting at `open` (an index of `(` or `{`). */
function balanced(src: string, open: number): string {
  const pair = src[open] === '(' ? [')', '('] : ['}', '{'];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === pair[1]) depth++;
    else if (src[i] === pair[0] && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}

/** Top-level keys of an object-literal body. */
function topKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (depth === 0) {
      const m = /^\s*([A-Za-z_]\w*)\s*:/.exec(body.slice(i));
      if (m && (i === 0 || /[,{\s]/.test(body[i - 1]!))) {
        keys.push(m[1]!);
        i += m[0].length - 1;
      }
    }
  }
  return keys;
}

describe('job code reads only Store fields the DO record serves', () => {
  const storeFields = META.models.Store!.fields as Record<string, { kind: string }>;
  const found: Array<{ file: string; keys: string[] }> = [];
  for (const scope of SCOPES) {
    const dir = path.join(API, scope);
    if (!fs.existsSync(dir)) continue;
    for (const file of files(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bstore\s*\.\s*(?:findUnique|findFirst)\s*\(/g)) {
        const call = balanced(src, m.index! + m[0].length - 1);
        const at = call.search(/\bselect\s*:\s*\{/);
        if (at < 0) continue;
        const sel = balanced(call, call.indexOf('{', at));
        found.push({ file: path.relative(API, file), keys: topKeys(sel) });
      }
    }
  }

  it('finds the known callers (the scanner is not blind)', () => {
    expect(found.some(f => f.file.endsWith('low-stock-scan.service.ts'))).toBe(true);
  });

  it('every selected key is a Store scalar or a served relation', () => {
    const bad = found.flatMap(f =>
      f.keys
        .filter(k => {
          const field = storeFields[k];
          return !field || (field.kind === 'relation' && !SERVED_RELATIONS.has(k));
        })
        .map(k => `${f.file}: Store.${k}`)
    );
    expect(bad).toEqual([]);
  });
});
