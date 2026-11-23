// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import en from '@/i18n/messages/en.json';
import ar from '@/i18n/messages/ar.json';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { SlugField } from './SlugField';
import { isValidProductSlug, slugForUpdate } from './slug-field';

afterEach(() => cleanup());

describe('product slug field (every-data-needs-UI: SlugRedirect trigger)', () => {
  it('renders an editable field that reports edits', () => {
    const onChange = vi.fn();
    render(<SlugField value="old-ring" onChange={onChange} />);
    const input = screen.getByLabelText('slug') as HTMLInputElement;
    expect(input.value).toBe('old-ring');
    fireEvent.change(input, { target: { value: 'new-ring' } });
    expect(onChange).toHaveBeenCalledWith('new-ring');
  });
  it('flags characters the API would reject', () => {
    render(<SlugField value="bad slug!" onChange={() => {}} />);
    expect(screen.getByText('slugInvalid')).toBeTruthy();
  });
  it('validates like the API (latin, digits, Arabic, hyphen)', () => {
    expect(isValidProductSlug('gold-ring-18')).toBe(true);
    expect(isValidProductSlug('خاتم-ذهب')).toBe(true);
    expect(isValidProductSlug('has space')).toBe(false);
    expect(isValidProductSlug('')).toBe(false);
  });
  it('sends slug only when it really changed', () => {
    expect(slugForUpdate('old-ring', 'old-ring')).toEqual({});
    expect(slugForUpdate('  ', 'old-ring')).toEqual({});
    expect(slugForUpdate(' New-Ring ', 'old-ring')).toEqual({ slug: 'new-ring' });
  });
  it('has ar + en labels', () => {
    for (const m of [en, ar]) {
      const f = (m as { products: { edit: { fields: Record<string, string> } } }).products.edit
        .fields;
      expect(f.slug && f.slugHint && f.slugInvalid).toBeTruthy();
    }
  });
});
