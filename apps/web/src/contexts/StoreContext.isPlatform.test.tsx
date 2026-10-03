// @vitest-environment jsdom
/**
 * Issue #1544 — `useStoreUrl`'s `isPlatform` used to start `false` on every
 * render and only correct itself in a `useEffect` via
 * `isPlatformHost(window.location.hostname)`. That means the server-rendered
 * HTML on a platform host (`<slug>.ebda.app`) always shipped a bare
 * `/` home href — a pre-hydration click, or a crawler following the raw
 * href, landed a merchant's shopper on the platform root instead of their
 * store.
 *
 * `middleware.ts` already resolves this for every request (`x-is-platform`);
 * `layout.tsx` now reads it and hands it to `StoreProvider` as
 * `initialIsPlatform`, which seeds `isPlatform` state directly instead of
 * discovering it only after mount.
 *
 * This test mocks `isPlatformHost` to always report "not a platform host" —
 * simulating what the OLD client-only detection would conclude on ANY
 * hostname jsdom hands it — so the only way `isPlatform` can read `true`
 * here is if the seeded prop actually wins and is not clobbered by the
 * mount effect. That makes it a real mutation gate: reverting `useStoreUrl`
 * to its own local `useState(false)` + unconditional
 * `isPlatformHost(window.location.hostname)` effect (the pre-fix shape)
 * turns the first assertion red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_THEME } from '@force/shared';
import { StoreProvider, useIsPlatform, useStoreUrl, type StoreData } from './StoreContext';

vi.mock('../lib/platform-host', () => ({
  // Always "custom domain" — the client-only fallback must never independently
  // decide `true`. Only a seeded `initialIsPlatform` prop can.
  isPlatformHost: vi.fn(() => false),
}));

afterEach(cleanup);

const baseStore: StoreData = {
  id: 'store123',
  name: 'Wady Al Juz',
  slug: 'wadyaljuz',
  status: 'active',
  currency: 'EGP',
  timezone: 'Africa/Cairo',
  template: 'elegant',
  theme: DEFAULT_THEME,
  socialLinks: {},
};

function Probe() {
  const storeUrl = useStoreUrl();
  const isPlatform = useIsPlatform();
  return (
    <div>
      <span data-testid="is-platform">{String(isPlatform)}</span>
      <span data-testid="home-href">{storeUrl('/')}</span>
    </div>
  );
}

describe('StoreProvider seeds isPlatform server-side', () => {
  it('trusts a seeded `initialIsPlatform=true` over the client host check', () => {
    render(
      <StoreProvider initialStore={baseStore} initialIsPlatform={true}>
        <Probe />
      </StoreProvider>
    );

    expect(screen.getByTestId('is-platform').textContent).toBe('true');
    // There is no path-based `/<slug>` storefront any more: even when the host is a
    // platform host, in-store links are never slug-prefixed (a platform host renders
    // no store at all).
    expect(screen.getByTestId('home-href').textContent).toBe('/');
  });

  it('trusts a seeded `initialIsPlatform=false` too (does not re-derive it away)', () => {
    render(
      <StoreProvider initialStore={baseStore} initialIsPlatform={false}>
        <Probe />
      </StoreProvider>
    );

    expect(screen.getByTestId('is-platform').textContent).toBe('false');
    expect(screen.getByTestId('home-href').textContent).toBe('/');
  });

  it('falls back to client-side host detection when no server value is given', () => {
    // No `initialIsPlatform` prop — e.g. a caller that predates this fix, or
    // any surface middleware.ts's `x-is-platform` header did not reach.
    render(
      <StoreProvider initialStore={baseStore}>
        <Probe />
      </StoreProvider>
    );

    expect(screen.getByTestId('is-platform').textContent).toBe('false');
    expect(screen.getByTestId('home-href').textContent).toBe('/');
  });
});
