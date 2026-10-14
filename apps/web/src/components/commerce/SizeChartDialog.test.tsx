// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { PublicSizeChart } from '@ebda/shared';

let lang: 'en' | 'ar' = 'en';
let arabicDigits = false;
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
vi.mock('@/hooks/useNumerals', () => ({
  useNumerals: () => ({
    localize: (v: string | number) =>
      arabicDigits ? String(v).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[Number(d)]) : String(v),
  }),
}));

import { SizeChartDialog, SizeChartTable } from './SizeChartDialog';

afterEach(() => {
  cleanup();
  lang = 'en';
  arabicDigits = false;
});

const arOnly: PublicSizeChart = {
  id: 'c1',
  name: '',
  nameAr: 'عباية',
  unit: 'cm',
  columns: [
    { label: '', labelAr: 'المقاس' },
    { label: '', labelAr: 'الطول' },
  ],
  rows: [
    ['S', '52'],
    ['M', '54'],
  ],
  note: '',
  noteAr: 'قياسات الجسم',
};

describe('SizeChartDialog', () => {
  it('renders nothing without a chart', () => {
    expect(render(<SizeChartDialog chart={null} />).container.innerHTML).toBe('');
    cleanup();
    expect(render(<SizeChartDialog chart={undefined} />).container.innerHTML).toBe('');
  });

  it('one text button with a ruler icon, localized', () => {
    lang = 'ar';
    render(<SizeChartDialog chart={arOnly} />);
    const btn = screen.getByRole('button', { name: 'دليل المقاسات' });
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('falls back to arabic in english: title, headers and note', () => {
    render(<SizeChartDialog chart={arOnly} />);
    fireEvent.click(screen.getByRole('button', { name: 'Size guide' }));
    const dialog = document.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(screen.getByRole('heading', { name: 'عباية' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'المقاس' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'الطول' })).toBeTruthy();
    expect(screen.getByText('قياسات الجسم')).toBeTruthy();
    // No blank header cell anywhere.
    for (const th of Array.from(dialog.querySelectorAll('thead th')))
      expect(th.textContent?.trim()).not.toBe('');
  });

  it('closes on a backdrop click, not on a click inside the box', () => {
    render(<SizeChartDialog chart={arOnly} />);
    fireEvent.click(screen.getByRole('button', { name: 'Size guide' }));
    const dialog = document.querySelector('dialog')!;
    fireEvent.click(screen.getByText('52'));
    expect(dialog.hasAttribute('open')).toBe(true);
    fireEvent.click(dialog);
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('the close button closes it', () => {
    lang = 'ar';
    render(<SizeChartDialog chart={arOnly} />);
    fireEvent.click(screen.getByRole('button', { name: 'دليل المقاسات' }));
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(document.querySelector('dialog')!.hasAttribute('open')).toBe(false);
  });
});

describe('SizeChartTable', () => {
  it('caption names the unit in the active language', () => {
    lang = 'ar';
    render(<SizeChartTable chart={arOnly} />);
    expect(screen.getByText('القياسات بالسنتيمتر')).toBeTruthy();
    cleanup();
    lang = 'en';
    render(<SizeChartTable chart={{ ...arOnly, unit: 'in' }} />);
    expect(screen.getByText('Measurements in inches')).toBeTruthy();
  });

  it('first column is a sticky row header; the table scrolls inside its own box', () => {
    const { container } = render(<SizeChartTable chart={arOnly} />);
    const rowHeader = screen.getByRole('rowheader', { name: 'S' });
    expect(rowHeader.className).toMatch(/sticky/);
    expect(rowHeader.className).toMatch(/start-0/);
    expect(container.querySelector('.overflow-x-auto table')).not.toBeNull();
  });

  it("measurements follow the store's numerals", () => {
    lang = 'ar';
    arabicDigits = true;
    render(<SizeChartTable chart={arOnly} />);
    expect(screen.getByText('٥٢')).toBeTruthy();
  });
});
