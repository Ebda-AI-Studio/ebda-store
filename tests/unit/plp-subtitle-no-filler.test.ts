/**
 * Quality bar Y-06 (Ruling B1-44): the product listing subtitle is the category's own description
 * in the shopper's language, or nothing. The platform never generates "Browse X" / "تصفح الX".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(
  path.resolve(__dirname, '../../apps/web/src/app/products/ProductsClient.tsx'),
  'utf8'
);

describe('PLP subtitle', () => {
  it('no generated "Browse" line in either language', () => {
    expect(src).not.toMatch(/Browse \$\{|Browse our collection/);
    expect(src).not.toContain('\\u062a\\u0635\\u0641\\u062d'); // "تصفح"
    expect(src).not.toContain('تصفح');
    expect(src).not.toContain('ctxArDefinite');
  });
  it('renders the category description (ar first on Arabic) and nothing when empty', () => {
    expect(src).toMatch(
      /language === 'ar'\s*\? activeCategory\?\.descriptionAr \|\| activeCategory\?\.description/
    );
    expect(src).toMatch(/\{subtitle && \(\s*<p/);
  });
});
