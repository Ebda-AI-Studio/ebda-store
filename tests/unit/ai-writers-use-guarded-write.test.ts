/**
 * Issue #620 / Ruling NEVER-OVERWRITE-1: every AI job writes product / category / image / store fields only through the guarded
 * fill-only layer (ai-autofill.service: writeAiFieldsGuarded, writeBulkProductFields / RowFields / StoreFields). A direct
 * `.product.update(...)` after the AI wait blind-writes over a merchant edit made meanwhile.
 *
 * The scan is an AST walk, so line breaks, comments, `db["product"]` and `["update"]` evasions do not hide a write. It covers the
 * AI job files AND the services / generators they import (a job can reach a write one hop away).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { writeBulkProductFields } from '@api/services/ai-autofill.service';

const SRC = join(__dirname, '../../apps/api/src');
const DIR = join(SRC, 'lib/inngest/functions');
const MODELS = new Set(['product', 'category', 'productImage', 'store']);
const WRITES = new Set(['update', 'updateMany', 'upsert']);
/** The guarded layer itself (the only code allowed to write these tables on behalf of the AI). */
const GUARDED_LAYER = 'services/ai-autofill.service.ts';

const keyOf = (e: ts.Expression): string | undefined =>
  ts.isIdentifier(e) ? e.text : ts.isStringLiteralLike(e) ? e.text : undefined;
/** `x.<name>` or `x["<name>"]` -> name (the object is returned too). */
function member(e: ts.Expression): { obj: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(e)) return { obj: e.expression, name: e.name.text };
  if (ts.isElementAccessExpression(e)) {
    const n = keyOf(e.argumentExpression);
    return n ? { obj: e.expression, name: n } : undefined;
  }
  return undefined;
}

/** Direct writes to a guarded model in `source`: `<x>.<model>.update|updateMany|upsert(` in any spelling, `storeUpdate(prisma`. */
export function directWrites(source: string, file = 'x.ts'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = member(n.expression);
      if (callee && WRITES.has(callee.name)) {
        const model = member(callee.obj);
        if (model && MODELS.has(model.name)) hits.push(`${model.name}.${callee.name}`);
      }
      if (ts.isIdentifier(n.expression) && n.expression.text === 'storeUpdate') {
        const first = n.arguments[0];
        if (first && ts.isIdentifier(first) && first.text === 'prisma')
          hits.push('storeUpdate(prisma)');
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

/**
 * Reached modules that write these tables for MERCHANT routes and are not scanned whole: a job may import only the named
 * helpers below (cache busting, no write). Importing anything else from them fails the test, so the exemption cannot widen.
 */
const NOT_SCANNED: Record<string, string[]> = {
  'services/store.service.ts': ['bustStoreCachesById'],
};

const aiJobs = readdirSync(DIR)
  .filter(f => /^(bulk-ai-|ai-autofill-).*\.ts$/.test(f) && !f.includes('.test.'))
  .map(f => join(DIR, f));

/** Local modules an AI job imports from services/ and lib/ai (one hop), minus the guarded layer. */
function reachable(): string[] {
  const out = new Set<string>();
  for (const f of aiJobs) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
    sf.forEachChild(n => {
      if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
      const spec = n.moduleSpecifier.text;
      if (!spec.startsWith('.')) return;
      const p = resolve(dirname(f), spec);
      const file = [`${p}.ts`, join(p, 'index.ts')].find(existsSync);
      if (!file || file.endsWith(GUARDED_LAYER)) return;
      if (Object.keys(NOT_SCANNED).some(k => file.endsWith(k))) return;
      if (/\/(services|lib\/ai)\//.test(file) && !aiJobs.includes(file)) out.add(file);
    });
  }
  return [...out];
}

describe('the scanner catches every spelling of a direct write (bad fixtures)', () => {
  const bad: Record<string, string> = {
    plain: 'await sw.product.update({ where: { id }, data })',
    'line break before .update': 'await db.product\n  .update({ where: { id }, data })',
    'bracket model': 'await db["product"].update({ where: { id }, data })',
    'bracket method': 'await db.category["updateMany"]({ where, data })',
    'both brackets': "await db['productImage']['update']({ where, data })",
    'multi-line chain':
      'await (\n  await storeWriter(storeId)\n)\n  .category\n  .update({ where, data })',
    upsert: 'await w.store.upsert({ where, create, update })',
    'storeUpdate on prisma': 'await storeUpdate(prisma, { where: { id }, data })',
  };
  for (const [name, src] of Object.entries(bad))
    it(`flags: ${name}`, () => expect(directWrites(src).length, src).toBeGreaterThan(0));

  const good: Record<string, string> = {
    'guarded helper': 'await writeBulkProductFields(storeId, id, row, { metaTitle })',
    'a comment': '// sw.product.update({ where })\n/* db.product\n.update() */',
    'a non-guarded model': 'await sw.bulkAiJob.update({ where, data })',
    'a read': 'await sdb.product.findUnique({ where })',
    'storeUpdate inside a tx': 'await storeUpdate(tx, { where, data })',
  };
  for (const [name, src] of Object.entries(good))
    it(`allows: ${name}`, () => expect(directWrites(src), src).toEqual([]));
});

/** Names an AI job imports from each NOT_SCANNED module. */
function importedFromExempt(): Array<{ job: string; module: string; name: string }> {
  const out: Array<{ job: string; module: string; name: string }> = [];
  for (const f of aiJobs) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
    sf.forEachChild(n => {
      if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
      const mod = Object.keys(NOT_SCANNED).find(k =>
        n.moduleSpecifier.getText().includes(k.replace(/\.ts$/, '').split('/').pop()!)
      );
      const bindings = n.importClause?.namedBindings;
      if (!mod || !bindings || !ts.isNamedImports(bindings)) return;
      for (const el of bindings.elements)
        out.push({ job: f, module: mod, name: (el.propertyName ?? el.name).text });
    });
  }
  return out;
}

describe('AI jobs write guarded tables only through the guarded fill-only layer', () => {
  it('finds the AI jobs and the modules they reach', () => {
    expect(aiJobs.length).toBeGreaterThan(10);
    expect(reachable().length).toBeGreaterThan(0);
  });
  it('jobs import only cache-busting helpers from the exempt merchant services', () => {
    const bad = importedFromExempt().filter(i => !NOT_SCANNED[i.module].includes(i.name));
    expect(bad).toEqual([]);
    expect(importedFromExempt().length).toBeGreaterThan(0);
  });
  for (const f of aiJobs)
    it(`${f.slice(SRC.length + 1)}: no direct product / category / productImage / store write`, () =>
      expect(directWrites(readFileSync(f, 'utf8'), f)).toEqual([]));
  for (const f of reachable())
    it(`reachable ${f.slice(SRC.length + 1)}: no direct product / category / productImage / store write`, () => {
      const hits = directWrites(readFileSync(f, 'utf8'), f);
      expect(hits, `${f} writes ${hits.join(', ')} outside the guarded layer`).toEqual([]);
    });
  for (const f of [
    'bulk-ai-seo.ts',
    'bulk-ai-translate.ts',
    'bulk-ai-excerpt.ts',
    'bulk-ai-aeo.ts',
    'bulk-ai-geo.ts',
  ])
    it(`${f}: uses writeBulkProductFields`, () =>
      expect(readFileSync(join(DIR, f), 'utf8')).toContain('writeBulkProductFields('));
});

describe('writeBulkProductFields', () => {
  it('without overwrite, a field already holding text is never a candidate (nothing is written)', async () => {
    expect(
      await writeBulkProductFields(
        's',
        'p',
        { metaTitle: 'merchant title' },
        { metaTitle: 'AI title', metaTitleAr: '  ' }
      )
    ).toEqual([]);
  });
});
