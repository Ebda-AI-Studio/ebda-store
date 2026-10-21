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

  it('shows the label, maxLength and counter; the hint waits for a blur (F6)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PersonalisationField config={cfg} value="" onChange={onChange} />);
    const input = screen.getByLabelText(/الاسم للتطريز/) as HTMLInputElement;
    expect(input.maxLength).toBe(12);
    expect(input.required).toBe(true);
    // first paint: no "fill it in first" yet, and (Y-04) no counter before the shopper types
    expect(screen.queryByText('اكتب الاسم للتطريز الأول')).toBeNull();
    expect(screen.queryByText('0/12')).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByText('0/12')).toBeTruthy();
    fireEvent.blur(input);
    expect(screen.getByText('اكتب الاسم للتطريز الأول')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: 'سارة' } });
    expect(onChange).toHaveBeenCalledWith('سارة');
    rerender(<PersonalisationField config={cfg} value="سارة" onChange={onChange} />);
    expect(screen.queryByText('اكتب الاسم للتطريز الأول')).toBeNull();
    expect(screen.getByText('4/12')).toBeTruthy();
  });

  it('a nudge focuses the field, scrolls it into view and reveals the hint', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(
      <PersonalisationField config={cfg} value="" onChange={() => {}} nudge={0} />
    );
    const input = screen.getByLabelText(/الاسم للتطريز/) as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    rerender(<PersonalisationField config={cfg} value="" onChange={() => {}} nudge={1} />);
    expect(document.activeElement).toBe(input);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(screen.getByText('اكتب الاسم للتطريز الأول')).toBeTruthy();
  });

  it('english on an Arabic-only label: the platform default, never the Arabic label (F4)', () => {
    lang = 'en';
    render(<PersonalisationField config={cfg} value="" onChange={() => {}} nudge={1} />);
    expect(screen.getByLabelText(/^Personalisation/)).toBeTruthy();
    expect(screen.queryByText(/الاسم للتطريز/)).toBeNull();
    expect(screen.getByText('Fill in “Personalisation” first')).toBeTruthy();
  });

  it('arabic on an English-only label: التخصيص', () => {
    render(
      <PersonalisationField
        config={{ ...cfg, label: 'Name', labelAr: '' }}
        value=""
        onChange={() => {}}
      />
    );
    expect(screen.getByLabelText(/^التخصيص/)).toBeTruthy();
  });

  // F14 (narrow from md up) is superseded by AT-2 (Ruling B1-70: the independent audit
  // gates): a field narrower than the CTA under it read as misaligned. See the AT-2 block.
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

// Y-04 (W3): an optional field says so, and the input shows an example.
describe('PersonalisationField optional marker and example', () => {
  it('optional: "(اختياري)" after the label; required: the asterisk only', () => {
    render(
      <PersonalisationField config={{ ...cfg, required: false }} value="" onChange={() => {}} />
    );
    expect(screen.getByText('(اختياري)')).toBeTruthy();
    cleanup();
    render(<PersonalisationField config={cfg} value="" onChange={() => {}} />);
    expect(screen.queryByText('(اختياري)')).toBeNull();
  });
  it('the input carries an example placeholder in the page language', () => {
    render(<PersonalisationField config={cfg} value="" onChange={() => {}} />);
    expect((screen.getByLabelText(/الاسم للتطريز/) as HTMLInputElement).placeholder).toBe(
      'مثال: منى'
    );
  });
});

// AT-2 (independent audit): at 1280 the embroidery field was narrower than the Add
// button below it (600 vs 930px). The field and its helper row span the buy column,
// the same width as the CTA.
describe('PersonalisationField width (AT-2)', () => {
  it('the input and its helper row are as wide as the buy column', () => {
    const { container } = render(
      <PersonalisationField config={cfg} value="" onChange={() => {}} />
    );
    const input = container.querySelector('input')!;
    expect(input.className).toMatch(/\bw-full\b/);
    expect(container.innerHTML).not.toMatch(/max-w-/);
  });
});
