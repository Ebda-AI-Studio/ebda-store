// @vitest-environment jsdom
/**
 * Search-as-you-type behaviour spec (docs/plans/done/2026-10-26-search-as-you-type.md): the header input
 * becomes an ARIA combobox, arrows work FROM the input, results show from one character, and a slow
 * older response never replaces a newer one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { SearchAutocomplete } from './SearchAutocomplete';

type Resolve = (v: unknown) => void;
const pending: Record<string, { resolve: Resolve; signal?: AbortSignal }> = {};
const searchSuggest = vi.fn(
  (q: string, signal?: AbortSignal) =>
    new Promise(resolve => {
      pending[q] = { resolve, signal };
    })
);
const product = (id: string, name: string) => ({
  id,
  name,
  nameAr: name,
  slug: id,
  price: 10,
  image: null,
});
const ok = (...p: ReturnType<typeof product>[]) => ({ success: true, data: { suggestions: p } });

vi.mock('../lib/api', () => ({
  api: { searchSuggest: (q: string, s?: AbortSignal) => searchSuggest(q, s) },
}));
vi.mock('../contexts/StoreContext', () => ({ useStoreUrl: () => (p: string) => p }));
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', t: (_en: string, ar: string) => ar }),
}));
vi.mock('../hooks/useLocalePrice', () => ({ useLocalePrice: () => (n: number) => String(n) }));

function Header() {
  const [q, setQ] = useState('');
  return (
    <form role="search" className="relative">
      <input aria-label="بحث" value={q} onChange={e => setQ(e.target.value)} />
      <SearchAutocomplete query={q} />
    </form>
  );
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

afterEach(() => {
  cleanup();
  searchSuggest.mockClear();
  for (const k of Object.keys(pending)) delete pending[k];
  vi.useRealTimers();
});

describe('SearchAutocomplete as an ARIA combobox', () => {
  it('searches from ONE Arabic letter and turns the input into a combobox', async () => {
    vi.useFakeTimers();
    const { getByLabelText, getAllByRole } = render(<Header />);
    const input = getByLabelText('بحث');
    fireEvent.change(input, { target: { value: 'ح' } });
    await tick(150);
    expect(searchSuggest).toHaveBeenCalledWith('ح', expect.any(AbortSignal));
    await act(async () => pending['ح'].resolve(ok(product('a', 'حذاء'), product('b', 'حقيبة'))));
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(getAllByRole('listbox')[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const opts = getAllByRole('option');
    expect(opts).toHaveLength(2);
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0].id);
    expect(opts[0].getAttribute('aria-selected')).toBe('true');
    // the matched letter is marked, as a text node (no HTML injection)
    expect(opts[0].querySelector('mark')?.textContent).toBe('ح');
  });

  it('never shows the older query results when they arrive late', async () => {
    vi.useFakeTimers();
    const { getByLabelText, queryAllByRole } = render(<Header />);
    const input = getByLabelText('بحث');
    fireEvent.change(input, { target: { value: 'ح' } });
    await tick(150);
    fireEvent.change(input, { target: { value: 'حذ' } });
    await tick(150);
    expect(pending['ح'].signal?.aborted).toBe(true);
    await act(async () => pending['حذ'].resolve(ok(product('b', 'حذاء'))));
    await act(async () => pending['ح'].resolve(ok(product('x', 'حقيبة قديمة'))));
    const names = queryAllByRole('option').map(o => o.textContent);
    expect(names).toEqual(['حذاء10']);
  });

  it('Escape closes the popup and typing reopens it; empty and error states are announced', async () => {
    vi.useFakeTimers();
    const { getByLabelText, queryByRole, getByRole, container } = render(<Header />);
    const input = getByLabelText('بحث');
    fireEvent.change(input, { target: { value: 'zz' } });
    await tick(150);
    await act(async () => pending['zz'].resolve(ok()));
    expect(getByRole('status').textContent).toBe('مفيش منتجات');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('مفيش منتجات');
    fireEvent.change(input, { target: { value: 'zzz' } });
    await tick(150);
    await act(async () => pending['zzz'].resolve({ success: false }));
    expect(getByRole('status').textContent).toContain('مش شغال');
    expect(queryByRole('option')).toBeNull();
  });
});
