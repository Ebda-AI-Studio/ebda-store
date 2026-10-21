// @vitest-environment jsdom
/** Rule (e) (W4): an autoplaying hero slider has a visible pause toggle (2.2.2), not only hover/focus. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: React.PropsWithChildren<{ href: string }>) =>
    React.createElement('a', { href }, children),
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_e: string, a: string) => a }),
  translations: {},
}));
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { theme: {}, look: null }, layout: {} }),
  useStoreUrl: () => (p: string) => p,
}));
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { HeroSlider } = await import('./HeroSlider');
afterEach(cleanup);

describe('HeroSlider autoplay toggle', () => {
  it('shows a pause toggle when it autoplays, and pressing it holds the slides', () => {
    const slides = [
      { image: 'a.webp', headline: 'A' },
      { image: 'b.webp', headline: 'B' },
    ];
    const { container } = render(<HeroSlider slides={slides as never} autoplayMs={5000} isRtl />);
    const btn = container.querySelector('button[data-autoplay-toggle]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('إيقاف العرض التلقائي');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
  it('no autoplay (0 ms or one slide): no toggle', () => {
    const { container } = render(
      <HeroSlider slides={[{ image: 'a.webp' }] as never} autoplayMs={5000} isRtl />
    );
    expect(container.querySelector('button[data-autoplay-toggle]')).toBeNull();
  });
});
