// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@web/contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (en: string) => en, language: 'en', isRTL: false }),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (en: string) => en, language: 'en', isRTL: false }),
}));

import { PoweredByEbda } from '../../apps/web/src/templates/shared/PoweredByEbda';

const root = join(__dirname, '..', '..');

describe('storefront "Powered by Ebda" mark', () => {
  it('is one ink (currentColor): follows the merchant footer ink, never gold or a gradient', () => {
    const { container } = render(<PoweredByEbda />);
    const svg = container.querySelector('[data-testid="ebda-badge-mark"]')!;
    expect(svg.getAttribute('fill')).toBe('currentColor');
    const markup = svg.outerHTML;
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(markup).not.toContain('url(');
    expect(container.querySelector('img')).toBeNull();
  });

  it('every template footer (5 themes + Dahab) renders this one badge', () => {
    for (const t of ['bold', 'classic', 'dahab', 'elegant', 'minimal', 'modern']) {
      const src = readFileSync(join(root, `apps/web/src/templates/${t}/Footer.tsx`), 'utf8');
      expect(src, t).toContain('<PoweredByEbda');
    }
  });
});
