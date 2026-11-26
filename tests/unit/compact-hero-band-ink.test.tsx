/** CompactHeroBand reads on the surface the hero wrapper paints (qamar-one h1 was 1.2:1 on `token:primary`). */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompactHeroBand } from '../../apps/web/src/templates/shared/CompactHeroBand';

const props = { title: 'Heliopolis Boutique', ctaText: 'Shop Now', ctaLink: '/products' };

describe('CompactHeroBand ink', () => {
  it('takes dark ink (and an ink button) on a light hero surface', () => {
    const html = renderToStaticMarkup(<CompactHeroBand {...props} bg="hsl(231 36% 80%)" />);
    expect(html).toMatch(/<h1[^>]*style="color:#000000"/);
    expect(html).toMatch(/<a[^>]*background-color:#000000/);
  });
  it('takes light ink on a dark hero surface', () => {
    const html = renderToStaticMarkup(<CompactHeroBand {...props} bg="#101840" />);
    expect(html).toMatch(/<h1[^>]*style="color:#ffffff"/);
  });
  it('keeps the token inks when no surface is set', () => {
    const html = renderToStaticMarkup(<CompactHeroBand {...props} />);
    expect(html).not.toMatch(/style=/);
  });
});

describe('echoesBrand (UI audit 2026-11-11)', () => {
  const html = (extra: object) =>
    renderToStaticMarkup(
      <CompactHeroBand title="Amelia Aurum" ctaText="Shop" ctaLink="/products" {...extra} />
    );
  it('a no-image hero never renders an empty strip: the store name stays a VISIBLE h1 beside the CTA (live QA 2026-11-17)', () => {
    const out = html({ echoesBrand: true });
    expect(out).toMatch(/<h1[^>]*>Amelia Aurum<\/h1>/);
    expect(out).not.toMatch(/sr-only/);
    expect(out).toContain('data-hero-quiet');
    expect(out).toMatch(/text-xl sm:text-2xl/); // compact, not the 30-36 px title
    expect(out).toMatch(/<a [^>]*href="\/products"[^>]*>Shop<\/a>/);
  });
  it('a subtitle keeps the title visible', () => {
    const out = html({ echoesBrand: true, subtitle: 'Gold, handmade' });
    expect(out).not.toMatch(/<h1[^>]*sr-only/);
  });
});
