import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('STORE-QA-42 categories page title + heading', () => {
  it('the document title goes through localizedMetadata with an Arabic variant', () => {
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(src).toContain("localizedMetadata({\n    title: ['Categories', 'الفئات']");
    expect(src).not.toMatch(/title: 'Categories'/);
  });
  it('the template branch renders a real h1', () => {
    const src = readFileSync(join(__dirname, 'CategoriesClient.tsx'), 'utf8');
    expect(src).toMatch(
      /<h1 className="sr-only">\{t\('Shop by Category', 'تسوق حسب الفئة'\)\}<\/h1>/
    );
  });
});
