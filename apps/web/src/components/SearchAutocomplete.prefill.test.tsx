// @vitest-environment jsdom
/**
 * PR 1 visual gate (search program): /search?q=<term> prefills the input, and the autocomplete
 * used to open a dropdown over the first row of the results the page already shows. It must stay
 * closed for the untouched prefilled term and open as soon as the visitor edits the field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { SearchAutocomplete } from './SearchAutocomplete';

const searchSuggest = vi.fn(async (_q: string) => ({
  success: true,
  data: { suggestions: [{ id: 'p1', name: 'Shoes', slug: 'shoes', price: 100, image: null }] },
}));

vi.mock('../lib/api', () => ({ api: { searchSuggest: (q: string) => searchSuggest(q) } }));
vi.mock('../contexts/StoreContext', () => ({ useStoreUrl: () => (p: string) => p }));
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', t: (en: string) => en }),
}));
vi.mock('../hooks/useNumerals', () => ({
  useNumerals: () => ({ money: (n: number) => String(n) }),
}));

afterEach(() => {
  cleanup();
  searchSuggest.mockClear();
  vi.useRealTimers();
});

describe('SearchAutocomplete prefilled query', () => {
  it('does not fetch or open for the term it mounted with', async () => {
    vi.useFakeTimers();
    const { container } = render(<SearchAutocomplete query="احذيه" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchSuggest).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('fetches once the visitor edits the term', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<SearchAutocomplete query="احذيه" />);
    rerender(<SearchAutocomplete query="احذيه ر" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchSuggest).toHaveBeenCalledWith('احذيه ر');
  });

  it('still fetches for a field that mounts empty', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<SearchAutocomplete query="" />);
    rerender(<SearchAutocomplete query="shoes" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchSuggest).toHaveBeenCalledWith('shoes');
  });
});

describe('SearchAutocomplete committed query changes without a remount (final review M1)', () => {
  it('stays closed when the URL query changes /search?q=a → /search?q=b while mounted', async () => {
    vi.useFakeTimers();
    // Same order SearchClient renders in: committedQuery updates first, then its effect syncs
    // the input (searchTerm) to the new value.
    const { rerender, container } = render(
      <SearchAutocomplete query="احذيه" committedQuery="احذيه" />
    );
    rerender(<SearchAutocomplete query="احذيه" committedQuery="شنط" />);
    rerender(<SearchAutocomplete query="شنط" committedQuery="شنط" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchSuggest).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  // Fresh terms: SUGGEST_CACHE is module-level, an earlier test's term would be a cache hit.
  it('a new committed query closes a dropdown the visitor had opened, and editing reopens it', async () => {
    vi.useFakeTimers();
    const { rerender, container } = render(
      <SearchAutocomplete query="كوتشي" committedQuery="كوتشي" />
    );
    rerender(<SearchAutocomplete query="كوتشي ا" committedQuery="كوتشي" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchSuggest).toHaveBeenCalledWith('كوتشي ا');
    expect(container.textContent).not.toBe('');
    searchSuggest.mockClear();
    rerender(<SearchAutocomplete query="كوتشي ا" committedQuery="جزم" />);
    rerender(<SearchAutocomplete query="جزم" committedQuery="جزم" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchSuggest).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
    rerender(<SearchAutocomplete query="جزم ج" committedQuery="جزم" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchSuggest).toHaveBeenCalledWith('جزم ج');
  });
});
