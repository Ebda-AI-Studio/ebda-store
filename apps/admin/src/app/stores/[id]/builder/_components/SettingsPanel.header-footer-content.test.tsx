// @vitest-environment jsdom
/**
 * Bug: "The visual (Page Builder) editor can't edit menu/logo/footer at
 * all." Confirmed live: the header and footer sections have ZERO `group:
 * 'content'` settings (menu/logo/footer-links are deliberately global store
 * data, edited elsewhere — Ruling BUILDER2-ADVANCED-1 already does this for
 * typography/dividers), so their Content tab rendered a dead-empty panel
 * with no indication anything was wrong or where to go instead.
 *
 * This doesn't port nav/logo/footer-link editing into the new builder (a
 * bigger product decision — see the triage report); it closes the narrower,
 * unambiguous gap: the Content tab must say SOMETHING and point the
 * merchant to where that content actually lives, matching the existing
 * typography/dividers "Edit in classic" affordance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PageDefinition } from '@force/shared';

vi.mock('next-intl', () => {
  const messages: Record<string, string> = {
    content: 'Content',
    design: 'Design',
    modeLabel: 'Editing mode',
    headerContentEmpty: 'The menu and logo live elsewhere for now.',
    footerContentEmpty: 'Footer links live elsewhere for now.',
    editInClassic: 'Edit in the classic page builder',
    editInBranding: 'Edit the logo in Branding',
  };
  const t = Object.assign((key: string) => messages[key] ?? key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { SettingsPanel } from './SettingsPanel';

const docWith = (type: string): PageDefinition => ({
  schemaVersion: 1,
  pageKey: 'home',
  sectionGroups: {
    header: type === 'header' ? [{ id: 'header', type: 'header', settings: {} }] : [],
    footer: type === 'footer' ? [{ id: 'footer', type: 'footer', settings: {} }] : [],
  },
  sections: type === 'hero' ? [{ id: 'hero', type: 'hero', settings: {} }] : [],
  siteSettings: {},
});

afterEach(cleanup);

function renderPanel(type: string, sectionId: string) {
  return render(
    <SettingsPanel
      storeId="store-1"
      doc={docWith(type)}
      selection={{ sectionId }}
      viewport="desktop"
      theme={undefined}
      errors={[]}
      dispatch={() => null}
    />
  );
}

describe('SettingsPanel — header/footer Content tab points elsewhere instead of rendering blank', () => {
  it('header: shows the explanatory copy + links to the classic builder and Branding', () => {
    renderPanel('header', 'header');
    const panel = screen.getByTestId('header-content-elsewhere');
    expect(panel.textContent).toContain('The menu and logo live elsewhere for now.');
    const classicLink = screen.getByText('Edit in the classic page builder').closest('a');
    expect(classicLink?.getAttribute('href')).toBe('/stores/store-1/page-builder');
    const brandingLink = screen.getByText('Edit the logo in Branding').closest('a');
    expect(brandingLink?.getAttribute('href')).toBe('/stores/store-1/branding');
  });

  it('footer: shows the explanatory copy + a link to the classic builder', () => {
    renderPanel('footer', 'footer');
    const panel = screen.getByTestId('footer-content-elsewhere');
    expect(panel.textContent).toContain('Footer links live elsewhere for now.');
    const classicLink = screen.getByText('Edit in the classic page builder').closest('a');
    expect(classicLink?.getAttribute('href')).toBe('/stores/store-1/page-builder');
  });

  it('a normal section (hero) never shows the header/footer fallback copy', () => {
    renderPanel('hero', 'hero');
    expect(screen.queryByTestId('header-content-elsewhere')).toBeNull();
    expect(screen.queryByTestId('footer-content-elsewhere')).toBeNull();
  });
});
