/**
 * a11y P2-5 (independent a11y audit): 18 card hearts on one page were all named
 * "Add to wishlist", so a screen-reader list of buttons could not tell them apart.
 * Every per-card action carries the product's name.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompareButton,
  RemoveFromWishlistButton,
  cardActionLabel,
} from '../../apps/web/src/templates/shared/card-actions';

const T = join(__dirname, '../../apps/web/src/templates');

describe('per-card actions are named with the product', () => {
  it('builds the label in both languages', () => {
    expect(cardActionLabel('wishlist-add', false, 'Linen abaya')).toBe(
      'Add Linen abaya to wishlist'
    );
    expect(cardActionLabel('wishlist-add', true, 'عباية كتان')).toBe(
      'إضافة عباية كتان إلى المفضلة'
    );
    expect(cardActionLabel('compare-remove', true, 'عباية كتان')).toBe(
      'إزالة عباية كتان من المقارنة'
    );
    expect(cardActionLabel('wishlist-remove', false)).toBe('Remove from wishlist');
  });

  it('compare and remove buttons render the name', () => {
    const c = renderToStaticMarkup(
      <CompareButton productId="p" onToggle={() => {}} productName="Linen abaya" />
    );
    expect(c).toContain('aria-label="Add Linen abaya to compare"');
    const r = renderToStaticMarkup(
      <RemoveFromWishlistButton productId="p" onRemove={() => {}} isRtl productName="عباية" />
    );
    expect(r).toContain('aria-label="إزالة عباية من المفضلة"');
  });

  it.each([
    'shared/PecannbeeProductCard.tsx',
    'elegant/ProductCard.tsx',
    'modern/ProductCard.tsx',
    'classic/ProductCard.tsx',
    'minimal/ProductCard.tsx',
    'bold/ProductCard.tsx',
  ])('%s passes the name to every card action', f => {
    const src = readFileSync(join(T, f), 'utf8');
    expect(src).not.toMatch(/aria-label=\{t\('Add to wishlist'/);
    for (const m of src.matchAll(/<(CompareButton|RemoveFromWishlistButton)\b[^>]*>/g)) {
      expect(m[0]).toMatch(/productName=/);
    }
  });
});

/**
 * a11y P2-14: the card link's name started with the badge ("NEW Open-front
 * abaya ..."). The name comes first and badges follow it; the chips themselves
 * are hidden from the accessibility tree (an aria-label on a span is ignored).
 */
describe('card link names lead with the product (P2-14)', async () => {
  const { cardLinkLabel } = await import('../../apps/web/src/templates/shared/card-actions');
  it('joins the name then the badges, skipping empty ones', () => {
    expect(cardLinkLabel('Linen abaya', ['New', false, undefined, '-20%'])).toBe(
      'Linen abaya, New, -20%'
    );
    expect(cardLinkLabel('عباية', [])).toBe('عباية');
  });

  it.each(['shared/PecannbeeProductCard.tsx', 'minimal/ProductCard.tsx'])(
    '%s hides its chips and names the link name-first',
    f => {
      const src = readFileSync(join(T, f), 'utf8');
      expect(src).not.toMatch(/aria-label=\{t\('New product'/);
      expect(src).toMatch(/cardLinkLabel\(/);
    }
  );
});
