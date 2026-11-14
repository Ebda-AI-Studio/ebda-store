// INV-AUDIT-3 guard: every function in the StoreDO layer that writes a stock quantity must also write an inventory_history
// movement row. Writers are DISCOVERED from the source (a stock-column UPDATE/INSERT, a call to a stock primitive), never listed
// by hand; the only hand-written list is the EXEMPTIONS below, each with its reason, so a NEW stock writer fails here until it
// either writes its movement row or is exempted on purpose (and a stale exemption fails too).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/do');

/** a stock-column write, or a call to a primitive that moves stock */
const WRITES_STOCK =
  /(UPDATE\s+(products|product_variants|\$\{table\})\s+SET[^`'"]*\binventory\s*=|INSERT\s+INTO\s+product_variants[^`'"]*\binventory\b|\b(decrementProduct|decrementVariant|forceDecrementVariant|restock|syncAggregate)\()/;
/** a movement row: the file's history helpers or a literal insert */
const WRITES_MOVEMENT =
  /(\bhistory\(|\brecordMovement\(|\bimportMovement\(|INSERT\s+INTO\s+inventory_history)/;

const EXEMPT: Record<string, string> = {
  'stock.ts#guarded': 'primitive: returns previous/new, the caller (checkout) records the sale row',
  'stock.ts#forceDecrementVariant':
    'primitive: returns previous/new, the caller records the sale row',
  'stock.ts#restock':
    'primitive: returns previous/new, the caller (refund, backorder cancel) records the row',
  'stock-ops.ts#syncAggregate':
    'helper: copies the warehouse SUM into the aggregate; every caller that moves stock records its row',
};

function writers(): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(dir, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    sf.forEachChild(node => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body)
        out.push({ id: `${file}#${node.name.text}`, text: node.getText(sf) });
      if (ts.isVariableStatement(node))
        for (const d of node.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.initializer && ts.isArrowFunction(d.initializer))
            out.push({ id: `${file}#${d.name.text}`, text: d.initializer.getText(sf) });
    });
  }
  return out;
}

it('the discovery finds the known stock writers (the guard is not vacuous)', () => {
  const ids = writers()
    .filter(w => WRITES_STOCK.test(w.text))
    .map(w => w.id);
  for (const known of [
    'stock-ops.ts#adjustProduct',
    'stock-ops.ts#setVariantInventory',
    'stock-books.ts#bulkSetInventory',
    'checkout.ts#placeOrder',
  ])
    expect(ids).toContain(known);
});

it('every stock-writing function writes an inventory_history movement row (or is exempt with a reason)', () => {
  const missing = writers()
    .filter(w => WRITES_STOCK.test(w.text) && !WRITES_MOVEMENT.test(w.text) && !(w.id in EXEMPT))
    .map(w => w.id);
  expect(missing).toEqual([]);
});

it('no exemption is stale: each exempt function still exists and still writes stock', () => {
  const byId = new Map(writers().map(w => [w.id, w.text]));
  for (const id of Object.keys(EXEMPT)) {
    const text = byId.get(id);
    expect(text, `${id} no longer exists`).toBeDefined();
    expect(WRITES_STOCK.test(text!), `${id} no longer writes stock: drop the exemption`).toBe(true);
  }
});
