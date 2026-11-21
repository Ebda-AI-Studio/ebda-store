import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WHATSAPP_PACKAGES, whatsappPackageName } from '../../packages/shared/src/brand';

/**
 * Ahmad 2026-11-19: Chat packages are named BY SIZE (monthly AI replies), never Starter / Growth / Pro: those collide with the Store's plan names.
 * Pins the names the Chat packages carry on ebda.app, and that the Chat guides and docs vendored here (which a merchant reads on help.ebda.app and
 * docs.ebda.app) name no package with a tier word. Mirrors ebda-whatsapp test/package-names.test.ts and test/package-names-guard.test.ts.
 */
const TIER = /\b(Starter|Growth|Professional|Pro)\b/;
const ROOT = path.resolve(__dirname, '../..');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('Chat package names are by size, in every language', () => {
  it('every paid package id has a size name derived from its credits, with a yearly twin, and no tier word', () => {
    for (const p of WHATSAPP_PACKAGES.filter(x => x.priceMinor > 0)) {
      for (const l of ['ar', 'en'] as const) {
        const n = whatsappPackageName(p.id as Exclude<typeof p.id, 'store-included'>, l);
        expect(n, `${p.id} ${l}`).not.toMatch(TIER);
        expect(n, `${p.id} ${l}`).not.toMatch(/المبتدئة|النمو|الاحترافية|الأعمال/);
        expect(n.startsWith(l === 'en' ? 'Chat ' : 'شات ')).toBe(true);
        expect(n).toContain(
          l === 'en' ? p.features.ai_credits.toLocaleString('en-US') : String(p.features.ai_credits)
        );
        expect(n.includes(l === 'en' ? 'yearly' : 'سنوي')).toBe(p.periodMonths === 12);
      }
    }
  });
  it('the vendored Chat help guides and docs name no package Starter / Growth / Pro', () => {
    const files = [
      ...walk(path.join(ROOT, 'apps/help/wa-source')),
      ...walk(path.join(ROOT, 'apps/docs/wa-source')),
      ...walk(path.join(ROOT, 'apps/help/content/ar/whatsapp')),
      ...walk(path.join(ROOT, 'apps/help/content/en/whatsapp')),
      ...walk(path.join(ROOT, 'apps/docs/content/whatsapp')),
    ];
    const hits = files.flatMap(f =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((l, i) => (TIER.test(l) ? `${path.relative(ROOT, f)}:${i + 1}` : ''))
        .filter(Boolean)
    );
    expect(hits).toEqual([]);
  });
});
