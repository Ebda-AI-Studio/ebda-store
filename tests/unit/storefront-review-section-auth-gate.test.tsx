// @vitest-environment jsdom
/**
 * Pre-QA sweep 2026-11-10 #7 / audit 2026-11-03 #15: the PDP review form may ask the API who the visitor is
 * (`GET /auth/me`) ONLY when the browser holds a session hint. A guest's view must not fire it (it logged a
 * red 401 in the console). This renders the real ReviewSection with and without the hint and counts the
 * `/auth/me` requests that actually leave the component, so a reordered or removed gate fails here.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';

const ctx = { hint: false };

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/products/p1' }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 's1', timezone: 'Africa/Cairo', theme: {} }, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: 'en',
      direction: 'ltr',
      isRtl: false,
      setLanguage: () => {},
      t: (en: string) => en,
    }),
  };
});
vi.mock('../../apps/web/src/lib/api', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    hasSessionHint: () => ctx.hint,
    api: { get: async () => ({ success: false }) },
  };
});

const { default: ReviewSection } = await import('../../apps/web/src/components/ReviewSection');

const fetchMock = vi.fn(async (url: string) => {
  if (/\/auth\/me$/.test(url)) return new Response('{}', { status: 200 });
  return new Response(
    JSON.stringify({ success: true, data: { reviews: [], averageRating: 0, totalCount: 0 } }),
    {
      status: 200,
    }
  );
});
const authMeCalls = () =>
  fetchMock.mock.calls.filter(([u]) => /\/auth\/me$/.test(String(u))).length;
const reviewListCalls = () =>
  fetchMock.mock.calls.filter(([u]) => /\/reviews\/product\//.test(String(u))).length;

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReviewSection asks /auth/me only behind the session hint', () => {
  it('a guest (no hint) renders the section without a single /auth/me request', async () => {
    ctx.hint = false;
    render(<ReviewSection storeId="s1" productId="p1" />);
    // Wait until the component has done its network work (the review list), then count.
    await waitFor(() => expect(reviewListCalls()).toBeGreaterThan(0));
    expect(authMeCalls()).toBe(0);
  });

  it('a browser with the hint asks exactly once', async () => {
    ctx.hint = true;
    render(<ReviewSection storeId="s1" productId="p1" />);
    await waitFor(() => expect(authMeCalls()).toBe(1));
    await waitFor(() => expect(reviewListCalls()).toBeGreaterThan(0));
    expect(authMeCalls()).toBe(1);
  });
});
