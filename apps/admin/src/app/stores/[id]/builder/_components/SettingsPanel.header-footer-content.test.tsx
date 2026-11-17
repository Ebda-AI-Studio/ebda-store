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
 * Bug 3 (E3) later ported the header menu / utility bar and the footer link
 * columns into this tab (`ChromeContentPanel`): they edit the DRAFT and go
 * live on Publish. The logo still lives in Branding (linked from the header
 * panel); announcement / brand-story keep their pointer notices.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PageDefinition } from '@ebda/shared';

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

vi.mock('../../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({
    data: {
      store: {
        settings: {
          navMenu: [{ label: 'Shop', labelAr: 'تسوق', href: '/products' }],
          footerLinks: {
            shop: [{ name: 'All', nameAr: 'الكل', href: '/products', enabled: true }],
            support: [{ name: 'FAQ', nameAr: 'الأسئلة', href: '/faq', enabled: true }],
            company: [{ name: 'About', nameAr: 'من نحن', href: '/about', enabled: true }],
          },
        },
      },
    },
  })),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('./MediaPicker', () => ({
  MediaPicker: ({ onPick }: { onPick: (url: string) => void }) => (
    <button
      type="button"
      data-testid="media-pick"
      onClick={() => onPick('https://media.ebda.app/l.png')}
    >
      pick
    </button>
  ),
}));

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
  const onChange = vi.fn();
  const view = render(
    <SettingsPanel
      storeId="store-1"
      doc={docWith(type)}
      selection={{ sectionId }}
      viewport="desktop"
      theme={undefined}
      errors={[]}
      dispatch={() => null}
      chromeEdit={{ chrome: undefined, liveVersion: 1, onChange }}
    />
  );
  return { ...view, onChange };
}

describe('SettingsPanel — header/footer Content tab edits the draft (bug 3, E3)', () => {
  it('header: shows the live menu links as editable rows, not the "lives elsewhere" notice', async () => {
    const { onChange } = renderPanel('header', 'header');
    expect(await screen.findByTestId('chrome-nav-label-0')).toBeTruthy();
    expect((screen.getByTestId('chrome-nav-label-0') as HTMLInputElement).value).toBe('Shop');
    expect((screen.getByTestId('chrome-nav-labelAr-0') as HTMLInputElement).value).toBe('تسوق');
    expect(screen.queryByTestId('header-content-elsewhere')).toBeNull();
    expect(onChange).not.toHaveBeenCalled(); // nothing is stored until the merchant edits
  });

  it('header: editing a label sends the whole menu as a draft patch (same shape as the classic editor)', async () => {
    const { onChange } = renderPanel('header', 'header');
    fireEvent.change(await screen.findByTestId('chrome-nav-label-0'), {
      target: { value: 'Store' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      navMenu: [{ label: 'Store', labelAr: 'تسوق', href: '/products' }],
    });
  });

  it('header: picking a logo sends ONLY that logo key as a draft patch; footer has no logo field', async () => {
    const { onChange } = renderPanel('header', 'header');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByTestId('chrome-logo-ar')).getByRole('button'));
    fireEvent.click(screen.getByTestId('media-pick'));
    expect(onChange).toHaveBeenLastCalledWith({ logoAr: 'https://media.ebda.app/l.png' });
    cleanup();
    renderPanel('footer', 'footer');
    await screen.findByTestId('chrome-footer-shop');
    expect(screen.queryByTestId('chrome-logo')).toBeNull();
  });

  it('header: add and remove a link', async () => {
    const { onChange } = renderPanel('header', 'header');
    fireEvent.click(await screen.findByTestId('chrome-nav-add'));
    expect((onChange.mock.lastCall?.[0] as { navMenu: unknown[] }).navMenu).toHaveLength(2);
    fireEvent.click(screen.getByTestId('chrome-nav-remove-0'));
    expect((onChange.mock.lastCall?.[0] as { navMenu: unknown[] }).navMenu).toHaveLength(1);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:x',
    'jav\tascript:alert(1)',
  ])('header: an unsafe link (%s) is flagged and never reaches the draft', async href => {
    const { onChange } = renderPanel('header', 'header');
    fireEvent.change(await screen.findByTestId('chrome-nav-href-0'), { target: { value: href } });
    expect(screen.getByRole('alert').textContent).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['/about', 'https://example.com/x', 'mailto:a@b.co', 'tel:+20100'])(
    'header: a safe link (%s) is accepted',
    async href => {
      const { onChange } = renderPanel('header', 'header');
      fireEvent.change(await screen.findByTestId('chrome-nav-href-0'), { target: { value: href } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(onChange).toHaveBeenCalledTimes(1);
    }
  );

  it('footer: shows the three link columns and sends only the edited column', async () => {
    const { onChange } = renderPanel('footer', 'footer');
    expect(await screen.findByTestId('chrome-footer-shop')).toBeTruthy();
    expect(screen.getByTestId('chrome-footer-support')).toBeTruthy();
    expect(screen.getByTestId('chrome-footer-company')).toBeTruthy();
    fireEvent.change(screen.getByTestId('chrome-footer-support-label-0'), {
      target: { value: 'Help' },
    });
    const patch = onChange.mock.lastCall?.[0] as { footerLinks: Record<string, unknown> };
    expect(Object.keys(patch.footerLinks)).toEqual(['support']);
  });

  it('footer: an unsafe column link is blocked too', async () => {
    const { onChange } = renderPanel('footer', 'footer');
    fireEvent.change(await screen.findByTestId('chrome-footer-shop-href-0'), {
      target: { value: 'javascript:alert(1)' },
    });
    expect(onChange).not.toHaveBeenCalled();
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
