// @vitest-environment jsdom
/**
 * #2162: a throttled (or unreachable) verification is NOT an invalid link —
 * it must not say "Invalid Link" and must offer to retry the same token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';

const lang = { language: 'en' as 'en' | 'ar' };
vi.mock('../../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang.language,
    isRtl: lang.language === 'ar',
    t: (en: string, ar: string) => (lang.language === 'ar' ? ar : en),
  }),
}));
vi.mock('../../../contexts/StoreContext', () => ({ useStoreUrl: () => (p: string) => p }));
vi.mock('../../../components', () => ({
  MinimalChrome: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import VerifyEmailClient from './VerifyEmailClient';

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => {
  lang.language = 'en';
  window.history.replaceState({}, '', '/auth/verify-email?token=tok123');
});
afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

async function mount() {
  await act(async () => {
    render(<VerifyEmailClient />);
  });
}

describe('VerifyEmailClient', () => {
  it('rate-limited: no "Invalid Link", and Try again re-posts the same token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(429, { success: false, error: { code: 'RATE_LIMITED', message: 'Too many' } })
      )
      .mockResolvedValueOnce(jsonRes(200, { success: true, data: {} }));
    globalThis.fetch = fetchMock as never;

    await mount();

    expect(screen.queryByText('Invalid Link')).toBeNull();
    expect(screen.getByText('Too many attempts')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ token: 'tok123' });
    expect(screen.getByText('Email Verified!')).toBeTruthy();
  });

  it('rate-limited in Arabic renders the Arabic heading', async () => {
    lang.language = 'ar';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes(429, { success: false, error: { code: 'RATE_LIMITED', message: 'x' } })
      ) as never;

    await mount();

    expect(screen.getByText('محاولات كتير')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حاول مرة أخرى' })).toBeTruthy();
  });

  it('a network failure is retryable too, not an invalid link', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as never;

    await mount();

    expect(screen.queryByText('Invalid Link')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a genuinely invalid token still says Invalid Link, with no retry', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes(400, { success: false, error: { code: 'TOKEN_INVALID', message: 'Invalid' } })
      ) as never;

    await mount();

    expect(screen.getByText('Invalid Link')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
