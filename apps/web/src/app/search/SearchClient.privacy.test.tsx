// @vitest-environment jsdom
/**
 * Ruling SEARCH-URL-1 (launch blocker 31): drive a real storefront search (the page, the typeahead
 * and the real API client) and prove the typed term appears in NO URL: not the address bar, not a
 * fetch URL, not history, not a console line. It travels only in the `X-Search-Query` header.
 * Fetch is stubbed; nothing leaves the process.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const PHONE = '01012345678';
const TERM = `منى ${PHONE}`;

let search = '';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/search',
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('../../components', () => ({
  ShopChrome: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { currency: 'EGP', theme: {}, look: undefined } }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', t: (en: string) => en }),
  translations: { Search: 'بحث' },
}));
vi.mock('../../contexts/CartContext', () => ({ useCart: () => ({ addItem: vi.fn(), items: [] }) }));
vi.mock('../../hooks/useTemplateComponents', () => ({
  useTemplateComponents: () => ({ components: null, isLoading: true }),
}));
vi.mock('../../hooks/useLocalePrice', () => ({ useLocalePrice: () => (n: number) => String(n) }));
vi.mock('../../templates/shared/section-bg', () => ({ darkLookListingBand: () => undefined }));

import { api } from '../../lib/api';
import SearchClient from './SearchClient';

type Call = { url: string; headers: Record<string, string> };
let calls: Call[] = [];

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: k => (m.has(k) ? m.get(k)! : null),
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  // Node 26 ships its own half-working `localStorage`; the API client needs a real one.
  vi.stubGlobal('localStorage', memoryStorage());
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = [];
  search = '';
  window.history.replaceState(null, '', '/search');
  sessionStorage.clear();
  api.setStoreId('11111111-1111-4111-8111-111111111111');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      const body = {
        success: true,
        data: { products: [], suggestions: [], categories: [], meta: {} },
      };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        clone() {
          return this;
        },
      };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
};

describe('storefront search keeps the term out of every URL', () => {
  it('a typed search sends the term only in a header', async () => {
    const logged: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(' '));
      });
    }
    const { container } = render(<SearchClient />);
    await flush();
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: TERM } });
    await flush(); // typeahead debounce
    fireEvent.submit(container.querySelector('form[role="search"]')!);
    await flush();

    const searchCalls = calls.filter(c => c.url.includes('/public/'));
    expect(searchCalls.length).toBeGreaterThan(0);
    const needles = [PHONE, encodeURIComponent(TERM), encodeURIComponent('منى')];
    for (const c of calls) for (const n of needles) expect(c.url).not.toContain(n);
    for (const n of needles) expect(window.location.href).not.toContain(n);
    expect(decodeURIComponent(window.location.href)).not.toContain('منى');
    expect(logged.join('\n')).not.toContain(PHONE);

    // and the term DID reach the API, in the header, for both the list and the typeahead
    const sent = searchCalls.map(c => c.headers['X-Search-Query']).filter(Boolean);
    expect(sent.map(h => decodeURIComponent(h))).toContain(TERM);
    expect(calls.some(c => c.url.includes('/search/suggest') && c.headers['X-Search-Query'])).toBe(
      true
    );
    expect(calls.some(c => /[?&](q|search)=/.test(c.url))).toBe(false);
  });

  it('refresh: the term comes back from history.state, with no ?q= in the URL', async () => {
    window.history.replaceState({ ebdaSearchTerm: TERM }, '', '/search');
    const { container } = render(<SearchClient />);
    await flush();
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe(TERM);
    const list = calls.find(c => c.url.includes('/public/products'));
    expect(list).toBeDefined();
    expect(list!.url).not.toContain(PHONE);
    expect(decodeURIComponent(list!.headers['X-Search-Query'])).toBe(TERM);
  });

  it('an old /search?q= link still works and is scrubbed from the address bar', async () => {
    window.history.replaceState(null, '', `/search?q=${encodeURIComponent(TERM)}`);
    search = `q=${encodeURIComponent(TERM)}`;
    const { container } = render(<SearchClient />);
    await flush();
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe(TERM);
    expect(window.location.href).not.toContain(PHONE);
    const list = calls.find(c => c.url.includes('/public/products'));
    expect(list!.url).not.toContain(PHONE);
  });
});
