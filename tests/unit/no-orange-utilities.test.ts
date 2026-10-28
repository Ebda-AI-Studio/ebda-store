/** Ebda's own UI carries no orange (brand rule; METAL-1 allows brass/amber as warning). Audit UI-14: two admin classes slipped in. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (/node_modules|\.next|\.open-next|\/out\b|dist/.test(p)) continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}
describe('no Tailwind orange utility in Ebda apps', () => {
  it('admin, orders, marketing, accounts and status use amber/yellow, never orange', () => {
    const hits: string[] = [];
    for (const app of ['admin', 'orders', 'marketing', 'accounts', 'status']) {
      const dir = path.join(ROOT, 'apps', app, 'src');
      for (const f of walk(dir))
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((l, i) => {
            if (/\b(?:bg|text|border|ring|from|to|via|fill|stroke)-orange-\d{2,3}\b/.test(l))
              hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
          });
    }
    expect(hits).toEqual([]);
  });
});
