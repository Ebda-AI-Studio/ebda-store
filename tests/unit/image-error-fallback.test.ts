import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { IMAGE_ERROR_FALLBACK_SCRIPT } from '../../apps/web/src/lib/image-error-fallback';

type Listener = (e: { target: unknown }) => void;

function run() {
  let listener: Listener | undefined;
  let capture: boolean | undefined;
  const document = {
    addEventListener(_t: string, l: Listener, c?: boolean) {
      listener = l;
      capture = c;
    },
  };
  vm.runInNewContext(IMAGE_ERROR_FALLBACK_SCRIPT, { document });
  return { listener: listener!, capture };
}

function img(src: string, parentTag = 'DIV') {
  const attrs: Record<string, string | null> = { srcset: 'x 1w', sizes: '100vw' };
  const removed: unknown[] = [];
  const sources = [{}, {}];
  const el = {
    tagName: 'IMG',
    currentSrc: src,
    src,
    getAttribute: (k: string) => attrs[k] ?? null,
    setAttribute: (k: string, v: string) => (attrs[k] = v),
    removeAttribute: (k: string) => delete attrs[k],
    parentNode: {
      tagName: parentTag,
      querySelectorAll: () => sources,
      removeChild: (c: unknown) => removed.push(c),
    },
  };
  return { el, attrs, removed };
}

describe('image 404 -> original fallback (PERF-STORE-3)', () => {
  it('registers one capture-phase listener', () => {
    expect(run().capture).toBe(true);
  });

  it('swaps a failed variant for the original, drops srcset/sizes, and only once', () => {
    const { listener } = run();
    const { el, attrs } = img('https://media.ebda.app/stores/s/products/a.jpg.w640.webp');
    listener({ target: el });
    expect(el.src).toBe('https://media.ebda.app/stores/s/products/a.jpg');
    expect(attrs.srcset).toBeUndefined();
    expect(attrs.sizes).toBeUndefined();
    // the original failing too must not loop
    el.currentSrc = el.src;
    listener({ target: el });
    expect(el.src).toBe('https://media.ebda.app/stores/s/products/a.jpg');
  });

  it('removes <picture> sources so they cannot re-select the missing file', () => {
    const { listener } = run();
    const { el, removed } = img('https://pub-x.r2.dev/dahab/hero.webp.w960.webp', 'PICTURE');
    listener({ target: el });
    expect(removed).toHaveLength(2);
    expect(el.src).toBe('https://pub-x.r2.dev/dahab/hero.webp');
  });

  it('ignores images that are not width variants, and non-images', () => {
    const { listener } = run();
    const plain = img('https://media.ebda.app/stores/s/a.jpg');
    listener({ target: plain.el });
    expect(plain.el.src).toBe('https://media.ebda.app/stores/s/a.jpg');
    expect(plain.attrs.srcset).toBe('x 1w');
    const notRaster = img('https://media.ebda.app/stores/s/a.svg.w640.webp');
    listener({ target: notRaster.el });
    expect(notRaster.el.src).toBe('https://media.ebda.app/stores/s/a.svg.w640.webp');
    expect(() => listener({ target: { tagName: 'SCRIPT' } })).not.toThrow();
    expect(() => listener({ target: null })).not.toThrow();
  });
});
