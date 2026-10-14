// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

let lang: 'en' | 'ar' = 'ar';
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
vi.mock('@/hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (v: string | number) => String(v), numerals: 'latn' }),
}));

import { PersonalisationField, personalisationMissing } from './PersonalisationField';

const cfg = { enabled: true, label: '', labelAr: 'الاسم للتطريز', maxLength: 12, required: true };

afterEach(() => {
  cleanup();
  lang = 'ar';
});

describe('PersonalisationField', () => {
  it('renders nothing when off, absent or malformed', () => {
    const { container: a } = render(
      <PersonalisationField config={null} value="" onChange={() => {}} />
    );
    const { container: b } = render(
      <PersonalisationField config={{ ...cfg, enabled: false }} value="" onChange={() => {}} />
    );
    const { container: c } = render(
      <PersonalisationField config={{ enabled: true }} value="" onChange={() => {}} />
    );
    expect(a.innerHTML + b.innerHTML + c.innerHTML).toBe('');
  });

  it('shows the label, maxLength, counter and the required hint until filled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PersonalisationField config={cfg} value="" onChange={onChange} />);
    const input = screen.getByLabelText(/الاسم للتطريز/) as HTMLInputElement;
    expect(input.maxLength).toBe(12);
    expect(input.required).toBe(true);
    expect(screen.getByText('اكتب الاسم للتطريز الأول')).toBeTruthy();
    expect(screen.getByText('0/12')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'سارة' } });
    expect(onChange).toHaveBeenCalledWith('سارة');
    rerender(<PersonalisationField config={cfg} value="سارة" onChange={onChange} />);
    expect(screen.queryByText('اكتب الاسم للتطريز الأول')).toBeNull();
    expect(screen.getByText('4/12')).toBeTruthy();
  });

  it('falls back to the Arabic label on an English storefront', () => {
    lang = 'en';
    render(<PersonalisationField config={cfg} value="" onChange={() => {}} />);
    expect(screen.getByLabelText(/الاسم للتطريز/)).toBeTruthy();
  });
});

describe('personalisationMissing (feeds the single add-to-cart disabled rule)', () => {
  it('is true only for a required, enabled config with no real text', () => {
    expect(personalisationMissing(cfg, '')).toBe(true);
    expect(personalisationMissing(cfg, '   ‮')).toBe(true);
    expect(personalisationMissing(cfg, 'Sara')).toBe(false);
    expect(personalisationMissing({ ...cfg, required: false }, '')).toBe(false);
    expect(personalisationMissing({ ...cfg, enabled: false }, '')).toBe(false);
    expect(personalisationMissing(null, '')).toBe(false);
  });
});
