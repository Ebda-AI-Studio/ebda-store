// @vitest-environment jsdom
/**
 * The template gallery (plan F44, F58-F61, F25): every template has a picture, the current one is marked,
 * choosing is a radio (arrow keys), Preview is only offered for a different template and carries the design choice,
 * and the tabs follow the reading direction. The big live preview is the canvas proposal (covered by the e2e).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { builtLookTemplates, looksForTemplate } from '@ebda/shared';

let locale = 'en';
vi.mock('next-intl', () => ({ useLocale: () => locale }));
vi.mock('@/i18n/useT', () => ({
  useT: () => Object.assign((k: string) => k, { has: () => true }),
}));

import { TemplateGallery } from './TemplateGallery';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(() => {
  cleanup();
  locale = 'en';
});

const families = builtLookTemplates();
const firstFamilyLooks = looksForTemplate(families[0]!).filter(l => l.status === 'built');
const mount = (over: Partial<Parameters<typeof TemplateGallery>[0]> = {}) => {
  const onPreview = vi.fn();
  const onClose = vi.fn();
  render(
    <TemplateGallery
      currentLook={null}
      busy={false}
      onPreview={onPreview}
      onClose={onClose}
      {...over}
    />
  );
  return { onPreview, onClose };
};

describe('TemplateGallery', () => {
  it('shows a picture for every look of the family, with its size set (no layout shift)', () => {
    mount();
    const cards = screen
      .getAllByRole('radio', { name: /./ })
      .filter(r => r.getAttribute('name')?.endsWith('-look'));
    expect(cards.length).toBe(firstFamilyLooks.length);
    const imgs = [...document.querySelectorAll('[role="radiogroup"] img')];
    expect(imgs.length).toBe(firstFamilyLooks.length);
    for (const img of imgs) {
      expect(img.getAttribute('src')).toMatch(/^\/looks\/[a-z]+\.[a-z]+\.webp$/);
      expect(img.getAttribute('width')).toBe('360');
      expect(img.getAttribute('height')).toBe('450');
    }
  });

  it('marks the current look and opens on its family', () => {
    const cur = firstFamilyLooks[0]!;
    mount({ currentLook: cur.id });
    expect(screen.getByText('currentBadge')).toBeTruthy();
    expect(
      screen.getByRole('radio', { name: new RegExp(`${cur.name.en}.*currentBadge`) })
    ).toBeTruthy();
  });

  it('offers Preview only for a different look, and passes the colours/fonts choice', () => {
    const [a, b] = firstFamilyLooks;
    const { onPreview } = mount({ currentLook: a!.id });
    expect(screen.getByText('pickPrompt')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${a!.name.en}`) }));
    expect((screen.getByTestId('look-preview') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('alreadyCurrent')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${b!.name.en}$`) }));
    const preview = screen.getByTestId('look-preview') as HTMLButtonElement;
    expect(preview.disabled).toBe(false);
    fireEvent.click(within(screen.getByTestId('gallery-detail')).getByLabelText('reset'));
    fireEvent.click(preview);
    expect(onPreview).toHaveBeenCalledWith(b!.id, 'reset');
  });

  it('is a modal dialog with a close button and Escape (cancel) wired to onClose', () => {
    const { onClose } = mount();
    const dlg = screen.getByTestId('look-switch-pane');
    expect(dlg.tagName).toBe('DIALOG');
    fireEvent.click(screen.getByTestId('gallery-close'));
    expect(onClose).toHaveBeenCalled();
    fireEvent(dlg, new Event('cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('is RTL in Arabic and the family tabs mirror their arrow keys', () => {
    locale = 'ar';
    mount();
    expect(screen.getByTestId('look-switch-pane').getAttribute('dir')).toBe('rtl');
    if (families.length > 1) {
      const tabs = screen.getAllByRole('tab');
      tabs[0]!.focus();
      fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
      expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    }
  });

  it('keeps Preview disabled and says so while a preview is being prepared', () => {
    const [a, b] = firstFamilyLooks;
    mount({ currentLook: a!.id, busy: true });
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${b!.name.en}$`) }));
    expect((screen.getByTestId('look-preview') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('previewing')).toBeTruthy();
  });
});
