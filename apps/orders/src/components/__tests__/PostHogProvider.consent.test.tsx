// @vitest-environment jsdom
// Ruling ICEBERG-ADM-CONSENT-1: orders PWA PostHog (same defect class as admin) loads only after the shared ebda_consent cookie says analytics.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const init = vi.fn();
const optOut = vi.fn();
const optIn = vi.fn();
const posthog: any = {
  __loaded: false,
  init: vi.fn((...a: unknown[]) => {
    init(...a);
    posthog.__loaded = true;
  }),
  opt_out_capturing: optOut,
  opt_in_capturing: optIn,
  capture: vi.fn(),
  get_distinct_id: () => 'd1',
  get_session_id: () => 's1',
};
vi.mock('posthog-js', () => ({ default: posthog }));
vi.mock('@sentry/nextjs', () => ({ setTag: () => {}, setContext: () => {} }));

import { PostHogProvider, captureEvent } from '../PostHogProvider';
import { analyticsConsentedFromCookies } from '@ebda/shared/tracking';
import { EBDA_CONSENT_EVENT, serializeConsent } from '@ebda/shared/tracking';

const setCookie = (v: string | null) => {
  document.cookie = v === null ? 'ebda_consent=; max-age=0; path=/' : `ebda_consent=${v}; path=/`;
};
const flush = () => act(async () => void (await new Promise(r => setTimeout(r, 0))));

beforeEach(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
  posthog.__loaded = false;
  vi.clearAllMocks();
  setCookie(null);
});
afterEach(() => {
  cleanup();
  setCookie(null);
});

describe('orders PostHog consent gate', () => {
  it('no consent cookie: posthog is never initialised and captureEvent sends nothing', async () => {
    render(
      <PostHogProvider>
        <p>x</p>
      </PostHogProvider>
    );
    await flush();
    expect(init).not.toHaveBeenCalled();
    captureEvent('x');
    expect(posthog.capture).not.toHaveBeenCalled();
  });
  it('declined consent: still nothing', async () => {
    setCookie(serializeConsent({ analytics: false, marketing: false }));
    render(<PostHogProvider>x</PostHogProvider>);
    await flush();
    expect(init).not.toHaveBeenCalled();
  });
  it('accepted analytics: initialises once', async () => {
    setCookie(serializeConsent({ analytics: true, marketing: false }));
    render(<PostHogProvider>x</PostHogProvider>);
    await flush();
    expect(init).toHaveBeenCalledTimes(1);
  });
  it('consent given later in the session (banner event): loads then; a later decline opts out', async () => {
    render(<PostHogProvider>x</PostHogProvider>);
    await flush();
    expect(init).not.toHaveBeenCalled();
    setCookie(serializeConsent({ analytics: true, marketing: true }));
    await act(async () => void window.dispatchEvent(new CustomEvent(EBDA_CONSENT_EVENT)));
    await flush();
    expect(init).toHaveBeenCalledTimes(1);
    setCookie(serializeConsent({ analytics: false, marketing: false }));
    await act(async () => void window.dispatchEvent(new CustomEvent(EBDA_CONSENT_EVENT)));
    expect(optOut).toHaveBeenCalled();
    captureEvent('after-decline');
    expect(posthog.capture).not.toHaveBeenCalled();
  });
  it('analyticsConsentedFromCookies ignores a malformed cookie', () => {
    setCookie('%7Bnot-json');
    expect(analyticsConsentedFromCookies(document.cookie)).toBe(false);
  });
});
