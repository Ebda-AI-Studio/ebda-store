/**
 * Ruling FU46-Y02d (coordinator 2026-10-16, Ahmad's "Egyptian for full sentences"): every AI
 * generator whose Arabic output a shopper reads (product FAQ, excerpt, how-to guides, store FAQ,
 * AI-answer descriptions, SEO/AEO meta, merchant review replies, marketing emails) asks for
 * Egyptian Arabic full sentences through ONE instruction, `EGYPTIAN_ARABIC_REGISTER`
 * (`apps/api/src/lib/ai/arabic-register.ts`). No prompt may ask for MSA any more. New output only:
 * nothing stored is rewritten. The translator (merchant text, faithful translation) and the
 * search-terms generator (shopper typing, already dialect) are out of scope.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { nodesOf, parseFile } from './helpers/ast-query';
import { EGYPTIAN_ARABIC_REGISTER } from '../../apps/api/src/lib/ai/arabic-register';

const ROOT = join(__dirname, '../..');
const GENERATORS = [
  'apps/api/src/lib/ai/product-excerpt-generator.ts',
  'apps/api/src/lib/ai/product-faq-generator.ts',
  'apps/api/src/lib/ai/product-meta-aeo-generator.ts',
  'apps/api/src/lib/ai/review-tools.ts',
  'apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts',
  'apps/api/src/lib/inngest/functions/bulk-ai-geo.ts',
  'apps/api/src/services/ai.service.ts',
];
const MSA_ASK = /formal MSA|Modern Standard Arabic|not dialect|not Egyptian/i;

describe('AI-generated shopper Arabic is Egyptian (FU46-Y02d)', () => {
  it('the one instruction asks for Egyptian full sentences and keeps the facts', () => {
    expect(EGYPTIAN_ARABIC_REGISTER).toMatch(/Egyptian Arabic/);
    expect(EGYPTIAN_ARABIC_REGISTER).toMatch(/not Modern Standard Arabic/);
    expect(EGYPTIAN_ARABIC_REGISTER).toMatch(/exactly as given/);
  });

  it.each(GENERATORS)('%s uses it and never asks for MSA', f => {
    const src = readFileSync(join(ROOT, f), 'utf8');
    expect(src).toMatch(/EGYPTIAN_ARABIC_REGISTER/);
    expect(src.replace(/^\s*(\/\/|\*).*$/gm, '')).not.toMatch(MSA_ASK);
  });

  it('every use of EGYPTIAN_ARABIC_REGISTER is interpolated into the prompt (not printed as text)', () => {
    // AST, not backtick counting: a use is an Identifier that is a template-literal substitution or a `+` operand;
    // a `${EGYPTIAN_ARABIC_REGISTER}` that sits inside a plain string would reach the model as literal text.
    for (const f of GENERATORS) {
      const sf = parseFile(join(ROOT, f));
      const all = nodesOf(sf);
      const uses = all.filter(
        (n): n is ts.Identifier =>
          ts.isIdentifier(n) &&
          n.text === 'EGYPTIAN_ARABIC_REGISTER' &&
          !ts.isImportSpecifier(n.parent)
      );
      expect(uses.length, `${f}: no use`).toBeGreaterThan(0);
      for (const u of uses) {
        const interpolated =
          ts.isTemplateSpan(u.parent) ||
          (ts.isBinaryExpression(u.parent) &&
            u.parent.operatorToken.kind === ts.SyntaxKind.PlusToken);
        expect(interpolated, `${f}: use at char ${u.getStart()} is not interpolated`).toBe(true);
      }
      const printedAsText = all.filter(
        n =>
          (ts.isStringLiteral(n) || ts.isTemplateLiteralToken(n)) &&
          n.text.includes('${EGYPTIAN_ARABIC_REGISTER}')
      );
      expect(printedAsText.length, `${f}: \${EGYPTIAN_ARABIC_REGISTER} printed as text`).toBe(0);
    }
  });

  it('the built prompts carry the instruction text', async () => {
    const { buildExcerptPrompt } =
      await import('../../apps/api/src/lib/ai/product-excerpt-generator');
    const { buildProductFaqPrompt } =
      await import('../../apps/api/src/lib/ai/product-faq-generator');
    const p = { name: 'Ring', nameAr: 'خاتم', description: 'Gold ring', descriptionAr: null };
    expect(buildExcerptPrompt({ storeId: 's', product: p } as never)).toContain(
      EGYPTIAN_ARABIC_REGISTER
    );
    expect(buildProductFaqPrompt({ storeId: 's', product: p } as never)).toContain(
      EGYPTIAN_ARABIC_REGISTER
    );
  });

  it('no other API prompt asks for MSA', () => {
    const r = spawnSync(
      'git',
      [
        'grep',
        '-n',
        '-i',
        '-E',
        'formal MSA|Modern Standard Arabic',
        '--',
        'apps/api/src',
        ':!apps/api/src/lib/ai/arabic-register.ts',
      ],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(r.stdout).toBe('');
  });
});
