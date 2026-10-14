// @vitest-environment jsdom
/**
 * Bug: "The visual (Page Builder) editor can't edit menu/logo/footer at
 * all." Confirmed live: header and footer have ZERO `group: 'content'`
 * settings (menu/logo/footer-links are deliberately global store data,
 * edited elsewhere — Ruling BUILDER2-ADVANCED-1 already does this for
 * typography/dividers), so their Content tab rendered a dead-empty panel
 * with no indication anything was wrong or where to go instead.
 *
 * A code-review pass on the first version of this fix (which special-cased
 * only `header`/`footer`) found the SAME zero-content-settings registry
 * shape on three more section types — `announcement`, `brand-story`,
 * `trust-strip` (all `styleSettings()`-only in the registry) — left with
 * the identical blank panel. `ContentElsewhereNotice` now covers all five
 * from one data-driven condition (`defs.length === 0`) instead of two
 * hardcoded cases.
 *
 * This doesn't port that content editing into the new builder (a bigger
 * product decision — see the triage report); it closes the narrower,
 * unambiguous gap: the Content tab must say SOMETHING and point the
 * merchant to where that content actually lives, matching the existing
 * typography/dividers "Edit in classic" affordance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PageDefinition } from '@force/shared';

const localeState = vi.hoisted(() => ({ value: 'en' }));

vi.mock('next-intl', async () => {
  const ar = (await import('@/i18n/messages/ar.json')).default.builder.settings;
  const messages: Record<string, string> = {
    content: 'Content',
    design: 'Design',
    modeLabel: 'Editing mode',
    headerContentEmpty: 'The menu and logo live elsewhere for now.',
    footerContentEmpty: 'Footer links live elsewhere for now.',
    announcementContentEmpty: "This bar's text lives elsewhere for now.",
    brandStoryContentEmpty: "This section's text and image live elsewhere for now.",
    trustStripContentEmpty: 'Write your own trust items: add them under this section.',
    editInClassic: 'Edit in the classic page builder',
    editAnnouncement: 'Edit announcement text',
    editStoreDescription: 'Edit store description',
    editTrustStripStyle: 'Edit strip style',
    editInBranding: 'Edit the logo in Branding',
  };
  const t = Object.assign(
    (key: string) =>
      (localeState.value === 'ar' ? (ar as Record<string, unknown>)[key] : messages[key]) ?? key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => localeState.value };
});

import { SettingsPanel } from './SettingsPanel';

const docWith = (type: string): PageDefinition => ({
  schemaVersion: 1,
  pageKey: 'home',
  sectionGroups: {
    header: type === 'header' ? [{ id: 'header', type: 'header', settings: {} }] : [],
    footer: type === 'footer' ? [{ id: 'footer', type: 'footer', settings: {} }] : [],
  },
  sections: ['hero', 'announcement', 'brand-story', 'trust-strip'].includes(type)
    ? [{ id: type, type, settings: {} }]
    : [],
  siteSettings: {},
});

afterEach(() => {
  cleanup();
  localeState.value = 'en';
});

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

  it.each([
    ['announcement', 'Edit announcement text', '/stores/store-1/announcement'],
    ['brand-story', 'Edit store description', '/stores/store-1/branding'],
  ])(
    '%s: points to the actual editor without claiming fixed content is editable',
    (type, label, href) => {
      renderPanel(type, type);
      const panel = screen.getByTestId(`${type}-content-elsewhere`);
      expect(panel.querySelector('a')?.textContent).toBe(label);
      expect(panel.querySelector('a')?.getAttribute('href')).toBe(href);
      expect(screen.queryByText('Edit the logo in Branding')).toBeNull();
    }
  );
  it.each([
    ['announcement', 'تعديل نص الإعلان', '/stores/store-1/announcement'],
    ['brand-story', 'تعديل وصف المتجر', '/stores/store-1/branding'],
  ])('%s: Arabic uses the same verified destination', (type, label, href) => {
    localeState.value = 'ar';
    renderPanel(type, type);
    const panel = screen.getByTestId(`${type}-content-elsewhere`);
    expect(panel.querySelector('a')?.textContent).toBe(label);
    expect(panel.querySelector('a')?.getAttribute('href')).toBe(href);
  });

  it('trust-strip: items are now editable as blocks, so the notice says so and links nowhere', () => {
    renderPanel('trust-strip', 'trust-strip');
    const panel = screen.getByTestId('trust-strip-content-elsewhere');
    expect(panel.textContent).toContain('Write your own trust items');
    expect(panel.querySelector('a')).toBeNull();
    expect(panel.textContent).not.toContain('fixed');
  });
});
