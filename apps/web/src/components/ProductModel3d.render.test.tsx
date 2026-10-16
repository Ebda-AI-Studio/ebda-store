// @vitest-environment jsdom
/**
 * PDP 3D (docs/plans/2026-10-07-product-3d-viewer.md):
 *  - the "View in 3D" toggle renders in both locales and flips to "Photos";
 *  - opening the panel mounts the viewer with the merchant's alt text, the
 *    poster, and the finish resolved from the shopper's PARTIAL pick;
 *  - VariantSelector reports the partial pick map and shows a swatch dot for a
 *    value with a colour binding (and none without).
 * The viewer module itself (three.js) is replaced by a stub: this test is about
 * what the PDP hands it, not WebGL (jsdom has none).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { PublicModel3d } from '@ebda/shared';

const viewerProps = vi.fn();
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: Record<string, unknown>) => {
    viewerProps(props);
    return React.createElement('div', { 'data-testid': 'viewer' });
  },
}));
vi.mock('./PostHogProvider', () => ({ captureEvent: vi.fn() }));
let lang: 'en' | 'ar' = 'en';
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import { Model3dToggle, ProductModel3dPanel } from './ProductModel3d';
import { VariantSelector } from './VariantSelector';
import type { ProductVariant, Product } from '@/lib/api';

const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);

const model: PublicModel3d = {
  modelUrl: 'https://media.ebda.app/stores/s/models/ring.glb',
  usdzUrl: null,
  posterUrl: 'https://media.ebda.app/stores/s/products/poster.webp',
  altText: 'Gold ring, 3D',
  altTextAr: 'خاتم دهب ثلاثي الأبعاد',
  arEnabled: true,
  bindings: [
    {
      optionName: 'Metal',
      value: 'Gold',
      kind: 'material',
      target: 'Band',
      color: '#ffc356',
      metalness: 1,
      roughness: 0.25,
    },
  ],
};

afterEach(() => {
  cleanup();
  viewerProps.mockClear();
  lang = 'en';
});

describe.each(['en', 'ar'] as const)('3D toggle (%s)', locale => {
  it('labels the closed and open states', () => {
    lang = locale;
    const onToggle = vi.fn();
    const { getByRole, rerender } = render(
      <Model3dToggle active={false} onToggle={onToggle} t={t} />
    );
    expect(getByRole('button').textContent).toBe(locale === 'ar' ? 'اعرضه 3D' : 'View in 3D');
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<Model3dToggle active onToggle={onToggle} t={t} />);
    expect(getByRole('button').getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button').textContent).toBe(locale === 'ar' ? 'الصور' : 'Photos');
  });
});

describe('3D panel → viewer props', () => {
  it('passes alt text per locale, poster, AR, and the finish of a partial pick', () => {
    lang = 'ar';
    render(
      <ProductModel3dPanel
        model={model}
        storeId="s"
        productId="p"
        productName="خاتم"
        selected={{ Metal: 'Gold' }}
        optionOrder={['Metal', 'Size']}
        isRtl
        t={t}
      />
    );
    const props = viewerProps.mock.calls.at(-1)![0];
    expect(props.src).toBe(model.modelUrl);
    expect(props.poster).toBe(model.posterUrl);
    expect(props.alt).toBe('خاتم دهب ثلاثي الأبعاد');
    expect(props.ar).toMatchObject({ enabled: true, usdzUrl: null, title: 'خاتم' });
    expect(props.look).toEqual({
      materials: { Band: { color: '#ffc356', metalness: 1, roughness: 0.25 } },
      gltfVariant: null,
    });
  });

  it('falls back to the first product photo as poster and a generated alt', () => {
    render(
      <ProductModel3dPanel
        model={{ ...model, posterUrl: null, altText: null, altTextAr: null }}
        storeId="s"
        productId="p"
        productName="Ring"
        fallbackPoster="https://media.ebda.app/p1.jpg"
        selected={{}}
        optionOrder={[]}
        isRtl={false}
        t={t}
      />
    );
    const props = viewerProps.mock.calls.at(-1)![0];
    expect(props.poster).toBe('https://media.ebda.app/p1.jpg');
    expect(props.alt).toBe('Ring — 3D model');
    expect(props.look).toEqual({ materials: {}, gltfVariant: null });
  });
});

describe('VariantSelector — partial picks + swatches for the 3D viewer', () => {
  type Opt = NonNullable<Product['options']>[number];
  const options = [
    { id: 'm', name: 'Metal', values: [{ value: 'Gold' }, { value: 'Rose' }] },
    { id: 's', name: 'Size', values: [{ value: 'S' }, { value: 'M' }] },
  ] as unknown as Opt[];
  const variants = ['Gold', 'Rose'].flatMap(metal =>
    ['S', 'M'].map(
      size =>
        ({
          id: `${metal}-${size}`,
          price: 1,
          inventory: 3,
          options: { Metal: metal, Size: size },
        }) as ProductVariant
    )
  );

  it('reports the partial pick before every option is chosen, and dots only bound values', () => {
    const onSelectionChange = vi.fn();
    const { getByText, container } = render(
      <VariantSelector
        variants={variants}
        options={options}
        onVariantSelect={vi.fn()}
        onSelectionChange={onSelectionChange}
        swatchColor={(o, v) => (o === 'Metal' && v === 'Gold' ? '#ffc356' : undefined)}
      />
    );
    fireEvent.click(getByText('Gold'));
    expect(onSelectionChange).toHaveBeenLastCalledWith({ Metal: 'Gold' });
    const dots = container.querySelectorAll('span[style*="background-color"]');
    expect(dots).toHaveLength(1);
    expect((dots[0] as HTMLElement).style.backgroundColor).toBe('rgb(255, 195, 86)');
  });
});
