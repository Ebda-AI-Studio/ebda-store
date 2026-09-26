// #1917 — the script called PWAService.updateSettings() and moved on
// regardless of what it returned, so a write that silently failed to persist
// (a stale connection, a swallowed error inside a transaction, etc.) was
// reported as a success. iconWriteLanded() is the check that now gates it,
// compared against the UPDATE ... RETURNING row updateSettings() itself
// returns — not a second query.
import { describe, it, expect } from 'vitest';
import { iconWriteLanded } from '../../scripts/backfill-store-pwa-icons';

describe('iconWriteLanded — confirms the write actually persisted', () => {
  it('is true when the returned row matches what was generated', () => {
    expect(
      iconWriteLanded(
        { iconAppleTouch: 'https://r2.example/store/apple-touch.png' },
        { iconAppleTouch: 'https://r2.example/store/apple-touch.png' }
      )
    ).toBe(true);
  });

  it('is false when the returned row still has no iconAppleTouch (write did not land)', () => {
    expect(
      iconWriteLanded({ iconAppleTouch: undefined }, { iconAppleTouch: 'https://r2.example/x.png' })
    ).toBe(false);
  });

  it('is false when the returned row disagrees with what was generated', () => {
    expect(
      iconWriteLanded(
        { iconAppleTouch: 'https://r2.example/stale.png' },
        { iconAppleTouch: 'https://r2.example/new.png' }
      )
    ).toBe(false);
  });
});
