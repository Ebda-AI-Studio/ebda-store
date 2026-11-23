// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'ar' };
});

import { AiPatchPane, type AiPatchProposal } from './AiPatchPane';

afterEach(cleanup);

const proposal: AiPatchProposal = {
  baseRev: 3,
  summaryEn: 'Slower slideshow',
  summaryAr: 'عرض أبطأ',
  ops: [],
  rejected: [{ index: 1, reason: 'UNKNOWN_SETTING' }],
  changes: [
    {
      op: 'setSectionSetting',
      id: 'hero',
      key: 'autoplayMs',
      before: 5000,
      after: 9000,
      labelEn: 'Hero banner: Slide duration',
      labelAr: 'البانر الرئيسي: مدة الشريحة',
    },
  ],
};

describe('AiPatchPane', () => {
  it('asks with the typed text and is RTL-aware (dir=auto on the input)', () => {
    const onAsk = vi.fn();
    render(
      <AiPatchPane
        busy={null}
        proposal={null}
        error={null}
        onAsk={onAsk}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    const box = screen.getByRole('textbox');
    expect(box.getAttribute('dir')).toBe('auto');
    expect(box.getAttribute('maxlength')).toBe('500');
    fireEvent.change(box, { target: { value: 'خلّي البانر أبطأ' } });
    fireEvent.click(screen.getByTestId('ai-patch-ask'));
    expect(onAsk).toHaveBeenCalledWith('خلّي البانر أبطأ');
  });

  it('does not ask for an empty request', () => {
    const onAsk = vi.fn();
    render(
      <AiPatchPane
        busy={null}
        proposal={null}
        error={null}
        onAsk={onAsk}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('ai-patch-ask'));
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('shows the Arabic summary and a before/after row, and applies or discards', () => {
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    render(
      <AiPatchPane
        busy={null}
        proposal={proposal}
        error={null}
        onAsk={vi.fn()}
        onApply={onApply}
        onDiscard={onDiscard}
      />
    );
    expect(screen.getByText('عرض أبطأ')).toBeTruthy();
    expect(screen.getByText('البانر الرئيسي: مدة الشريحة')).toBeTruthy();
    expect(screen.getByText('5000')).toBeTruthy();
    expect(screen.getByText('9000')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-patch-apply'));
    expect(onApply).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ai-patch-discard'));
    expect(onDiscard).toHaveBeenCalled();
  });

  it('with no applicable change offers no Apply button', () => {
    render(
      <AiPatchPane
        busy={null}
        proposal={{ ...proposal, changes: [] }}
        error={null}
        onAsk={vi.fn()}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    expect(screen.queryByTestId('ai-patch-apply')).toBeNull();
  });
});

describe('AiPatchPane: v2 ops and fill-only note', () => {
  const v2: AiPatchProposal = {
    baseRev: 1,
    summaryEn: 'Show bracelets',
    summaryAr: 'اعرض الإسورات',
    ops: [],
    rejected: [
      { index: 2, reason: 'OVERWRITE_PROTECTED' },
      { index: 3, reason: 'NOT_ALLOWED' },
    ],
    changes: [
      {
        op: 'setRef',
        id: 'c',
        key: 'manualProductIds',
        before: undefined,
        after: ['p-1', 'p-2'],
        labelEn: 'Carousel: Products',
        labelAr: 'الكاروسيل: المنتجات',
      },
      { op: 'addBlock', id: 'hero', labelEn: 'Hero: add Slide', labelAr: 'البانر: إضافة شريحة' },
    ],
  };

  it("shows a product list as a count, a new block as added, and says what was kept as the merchant's own", () => {
    render(
      <AiPatchPane
        busy={null}
        proposal={v2}
        error={null}
        onAsk={vi.fn()}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    expect(screen.getByText('products_count')).toBeTruthy();
    expect(screen.getByText('added_block')).toBeTruthy();
    // one part kept (fill-only), one skipped: two separate lines, never merged into one count
    expect(screen.getByText('kept')).toBeTruthy();
    expect(screen.getByText('skipped')).toBeTruthy();
  });
});

describe('AiPatchPane: examples and previews', () => {
  const renderPane = (proposal: AiPatchProposal | null) =>
    render(
      <AiPatchPane
        busy={null}
        proposal={proposal}
        error={null}
        onAsk={vi.fn()}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
  const row = (over: Partial<AiPatchProposal['changes'][number]>): AiPatchProposal => ({
    baseRev: 1,
    summaryEn: 's',
    summaryAr: 's',
    ops: [],
    rejected: [],
    changes: [{ op: 'setSectionSetting', id: 'x', key: 'k', labelEn: 'L', labelAr: 'L', ...over }],
  });

  it('offers 4 example chips and a click fills the textarea, focused, caret at the end', () => {
    renderPane(null);
    const chips = ['example1', 'example2', 'example3', 'example4'].map(k => screen.getByText(k));
    expect(chips).toHaveLength(4);
    fireEvent.click(chips[2]!);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.value).toBe('example3');
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe('example3'.length);
  });

  it('shows a colour change as swatch plus hex text', () => {
    const { container } = renderPane(row({ key: 'primary', before: '#112233', after: '#B08D57' }));
    expect(container.querySelectorAll('[data-preview="colour"]')).toHaveLength(2);
    expect(screen.getByText('#b08d57')).toBeTruthy();
    expect(screen.getByText('#112233')).toBeTruthy();
  });

  it('shows an image change as two thumbnails with empty alt', () => {
    const { container } = renderPane(
      row({ op: 'setRef', key: 'imageUrl', before: '/a/old.jpg', after: '/a/new.jpg' })
    );
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[1]!.getAttribute('alt')).toBe('');
    expect(imgs[1]!.getAttribute('src')).toBe('/a/new.jpg');
  });

  it('shows a text change clipped, dir=auto', () => {
    const long = 'ن'.repeat(200);
    const { container } = renderPane(row({ before: 'Old title', after: long }));
    const t = container.querySelectorAll('[data-preview="text"]');
    expect(t).toHaveLength(2);
    expect(t[1]!.getAttribute('dir')).toBe('auto');
    expect(t[1]!.textContent!.length).toBeLessThan(100);
  });
});
