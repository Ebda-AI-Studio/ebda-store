// @vitest-environment jsdom
/**
 * Review item 6: the recovery email ships OFF (Ruling CART-EMAIL-2), so the Abandoned carts page
 * nudges the merchant once, dismissibly. The nudge only exists while the channel is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));

import { CartEmailNudge, nudgeStorageKey } from './CartEmailNudge';

const mem = new Map<string, string>();
function stubStorage(blocked = false) {
  // This jsdom origin has no localStorage; a Map-backed stand-in (or one that throws).
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => {
        if (blocked) throw new Error('blocked');
        return mem.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (blocked) throw new Error('blocked');
        mem.set(k, v);
      },
    },
  });
}
beforeEach(() => {
  mem.clear();
  stubStorage();
});
afterEach(() => cleanup());

describe('CartEmailNudge', () => {
  it('shows while the email channel is off', () => {
    render(<CartEmailNudge storeId="s1" emailEnabled={false} />);
    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'review' })).toBeTruthy();
  });

  it('is absent once the channel is on', () => {
    render(<CartEmailNudge storeId="s1" emailEnabled />);
    expect(screen.queryByText('title')).toBeNull();
  });

  it('"Not now" dismisses it and remembers per store', () => {
    const { unmount } = render(<CartEmailNudge storeId="s1" emailEnabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByText('title')).toBeNull();
    expect(localStorage.getItem(nudgeStorageKey('s1'))).toBe('1');
    unmount();
    render(<CartEmailNudge storeId="s1" emailEnabled={false} />);
    expect(screen.queryByText('title')).toBeNull();
    cleanup();
    render(<CartEmailNudge storeId="s2" emailEnabled={false} />); // another store is unaffected
    expect(screen.getByText('title')).toBeTruthy();
  });

  it('still renders and dismisses when localStorage is blocked', () => {
    stubStorage(true);
    render(<CartEmailNudge storeId="s1" emailEnabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByText('title')).toBeNull();
  });
});
