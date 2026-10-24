// @vitest-environment jsdom
/**
 * The Theme tab no longer offers the persona-chrome switch: only the deleted Force skins read it
 * (Ruling SKIN-DEL-5). The key stays in the theme schema, accepted and ignored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: () => Object.assign((k: string) => k, { has: () => true }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('./BrandPreview', () => ({ BrandPreview: () => null }));
vi.mock('../../../../../components/ImageUpload', () => ({ ImageUpload: () => null }));
vi.mock('../../../../../components/ColorField', () => ({ ColorField: () => null }));

import { ThemeTab } from './ThemeTab';
import { DEFAULT_THEME, type StoreBranding } from './types';

function tab(template: string | undefined) {
  const branding = {
    id: 's',
    name: 'S',
    template,
    theme: { ...DEFAULT_THEME },
    socialLinks: {},
  } as unknown as StoreBranding;
  render(<ThemeTab branding={branding} onChange={() => {}} storeId="s" />);
  return [...document.querySelectorAll('[data-theme-toggle]')].map(e =>
    e.getAttribute('data-theme-toggle')
  );
}
afterEach(cleanup);

describe('ThemeTab by template', () => {
  it('no template gets a persona-chrome switch (SKIN-DEL-5), including a store with no template', () => {
    for (const t of ['qamar', 'souq', 'jasmine', 'lamma', 'dahab', undefined]) {
      expect(tab(t), String(t)).not.toContain('persona-chrome');
      cleanup();
    }
  });

  it('never more than 7 toggle cards on screen', () => {
    expect(tab('qamar').length).toBeLessThanOrEqual(7);
  });
});
