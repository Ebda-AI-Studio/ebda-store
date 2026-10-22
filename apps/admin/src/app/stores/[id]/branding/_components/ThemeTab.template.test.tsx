// @vitest-environment jsdom
/**
 * Task 10 (EP Task 4, Ruling EP-1): the Theme tab offers the persona-chrome switch only to the
 * skins that read it, and keeps it for a store whose template is unknown.
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

import { ThemeTab, PERSONA_CHROME_SKINS } from './ThemeTab';
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
  it('Qamar, Souq, Jasmine, Lamma, Minimal, Modern and Dahab: no persona-chrome switch', () => {
    for (const t of ['qamar', 'souq', 'jasmine', 'lamma', 'minimal', 'modern', 'dahab']) {
      expect(tab(t), t).not.toContain('persona-chrome');
      cleanup();
    }
  });

  it('Bold, Classic and Elegant read it, so they keep it', () => {
    for (const t of PERSONA_CHROME_SKINS) {
      expect(tab(t), t).toContain('persona-chrome');
      cleanup();
    }
  });

  it('an unknown template keeps it (never hide on missing evidence)', () => {
    expect(tab(undefined)).toContain('persona-chrome');
  });

  it('never more than 7 toggle cards on screen', () => {
    expect(tab('bold').length).toBeLessThanOrEqual(7);
  });
});
