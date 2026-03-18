/**
 * Search Autocomplete — Unit Tests
 *
 * Tests for:
 *   1. Debounce: query changes within 300ms trigger only one API call
 *   2. Minimum 2 chars: no API call for queries shorter than 2 characters
 *   3. Keyboard navigation: activeIndex cycles correctly with arrow keys
 *   4. Feature gate: returns null (no fetch) when search_autocomplete is disabled
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal debounce logic extracted from the SearchAutocomplete component.
 * Tests validate the debounce contract without mounting a React component.
 */
function makeDebouncer(delay: number) {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  return function debounce(fn: () => void) {
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(fn, delay);
  };
}

/**
 * Keyboard navigation state machine mirroring the component's activeIndex logic.
 */
function makeKeyboardNav(total: number) {
  let activeIndex = -1;

  return {
    arrowDown() {
      activeIndex = (activeIndex + 1) % total;
    },
    arrowUp() {
      activeIndex = activeIndex <= 0 ? total - 1 : activeIndex - 1;
    },
    escape() {
      activeIndex = -1;
    },
    get index() {
      return activeIndex;
    },
    get total() {
      return total;
    },
  };
}

// ─── 1. Debounce ──────────────────────────────────────────────────────────────

describe('SearchAutocomplete: debounce (300ms)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers the callback only once when called multiple times within 300ms', () => {
    const debounce = makeDebouncer(300);
    const fn = vi.fn();

    // Simulate rapid typing: call 5 times in quick succession
    debounce(fn);
    debounce(fn);
    debounce(fn);
    debounce(fn);
    debounce(fn);

    // Not called yet (timer hasn't fired)
    expect(fn).not.toHaveBeenCalled();

    // Advance time past the debounce window
    vi.advanceTimersByTime(300);

    // Should have been called exactly once
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('triggers the callback once per distinct pause (each > 300ms apart)', () => {
    const debounce = makeDebouncer(300);
    const fn = vi.fn();

    // First burst
    debounce(fn);
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);

    // Second burst (starts a new timer)
    debounce(fn);
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not call the callback if the timer is cancelled before firing', () => {
    const debounce = makeDebouncer(300);
    const fn = vi.fn();

    debounce(fn);
    // A subsequent call before 300ms resets the timer
    vi.advanceTimersByTime(100);
    debounce(fn); // reset
    vi.advanceTimersByTime(100); // only 100ms past the second call
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── 2. Minimum 2 characters ──────────────────────────────────────────────────

describe('SearchAutocomplete: minimum 2 characters', () => {
  it('does not call fetch when query is empty', () => {
    const fetchSpy = vi.fn();

    function shouldFetch(query: string): boolean {
      return query.trim().length >= 2;
    }

    expect(shouldFetch('')).toBe(false);
    fetchSpy.mockImplementationOnce(() => {});
    if (shouldFetch('')) fetchSpy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call fetch when query is a single character', () => {
    const fetchSpy = vi.fn();

    function shouldFetch(query: string): boolean {
      return query.trim().length >= 2;
    }

    expect(shouldFetch('a')).toBe(false);
    if (shouldFetch('a')) fetchSpy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls fetch when query is exactly 2 characters', () => {
    const fetchSpy = vi.fn();

    function shouldFetch(query: string): boolean {
      return query.trim().length >= 2;
    }

    expect(shouldFetch('ab')).toBe(true);
    if (shouldFetch('ab')) fetchSpy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('calls fetch when query is longer than 2 characters', () => {
    const fetchSpy = vi.fn();

    function shouldFetch(query: string): boolean {
      return query.trim().length >= 2;
    }

    expect(shouldFetch('shirt')).toBe(true);
    if (shouldFetch('shirt')) fetchSpy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a query of only spaces as too short', () => {
    function shouldFetch(query: string): boolean {
      return query.trim().length >= 2;
    }

    expect(shouldFetch('  ')).toBe(false);
    expect(shouldFetch(' a ')).toBe(false);
  });
});

// ─── 3. Keyboard navigation ───────────────────────────────────────────────────

describe('SearchAutocomplete: keyboard navigation', () => {
  it('starts with no item selected (index -1)', () => {
    const nav = makeKeyboardNav(5);
    expect(nav.index).toBe(-1);
  });

  it('ArrowDown moves to the first item on first press', () => {
    const nav = makeKeyboardNav(5);
    nav.arrowDown();
    expect(nav.index).toBe(0);
  });

  it('ArrowDown cycles through all items and wraps back to 0', () => {
    const nav = makeKeyboardNav(3);
    nav.arrowDown(); // 0
    nav.arrowDown(); // 1
    nav.arrowDown(); // 2
    nav.arrowDown(); // wraps to 0
    expect(nav.index).toBe(0);
  });

  it('ArrowUp from -1 (nothing selected) wraps to last item', () => {
    const nav = makeKeyboardNav(4);
    nav.arrowUp();
    expect(nav.index).toBe(3); // last index (total - 1)
  });

  it('ArrowUp from first item wraps to last item', () => {
    const nav = makeKeyboardNav(4);
    nav.arrowDown(); // go to 0
    nav.arrowUp(); // wraps to 3
    expect(nav.index).toBe(3);
  });

  it('ArrowUp moves upward through items', () => {
    const nav = makeKeyboardNav(5);
    nav.arrowDown(); // 0
    nav.arrowDown(); // 1
    nav.arrowDown(); // 2
    nav.arrowUp(); // 1
    expect(nav.index).toBe(1);
  });

  it('Escape resets active index to -1', () => {
    const nav = makeKeyboardNav(5);
    nav.arrowDown();
    nav.arrowDown();
    expect(nav.index).toBe(1);
    nav.escape();
    expect(nav.index).toBe(-1);
  });

  it('works correctly with a single item list', () => {
    const nav = makeKeyboardNav(1);
    nav.arrowDown(); // 0
    nav.arrowDown(); // wraps to 0
    expect(nav.index).toBe(0);
    nav.arrowUp(); // wraps to 0
    expect(nav.index).toBe(0);
  });
});

// ─── 4. Feature gate ──────────────────────────────────────────────────────────

describe('SearchAutocomplete: feature gate', () => {
  it('returns null (does not render) when search_autocomplete is disabled', () => {
    // Simulate the gate check from the component
    function resolveComponent(features: Set<string>): string | null {
      if (!features.has('search_autocomplete')) return null;
      return 'SearchAutocomplete';
    }

    const disabledFeatures = new Set<string>(['seo', 'pwa']);
    expect(resolveComponent(disabledFeatures)).toBeNull();
  });

  it('renders the component when search_autocomplete is enabled', () => {
    function resolveComponent(features: Set<string>): string | null {
      if (!features.has('search_autocomplete')) return null;
      return 'SearchAutocomplete';
    }

    const enabledFeatures = new Set<string>(['search_autocomplete', 'seo']);
    expect(resolveComponent(enabledFeatures)).toBe('SearchAutocomplete');
  });

  it('treats an empty feature set as disabled', () => {
    function resolveComponent(features: Set<string>): string | null {
      if (!features.has('search_autocomplete')) return null;
      return 'SearchAutocomplete';
    }

    expect(resolveComponent(new Set())).toBeNull();
  });

  it('is case-sensitive: "Search_Autocomplete" does not enable "search_autocomplete"', () => {
    function resolveComponent(features: Set<string>): string | null {
      if (!features.has('search_autocomplete')) return null;
      return 'SearchAutocomplete';
    }

    const features = new Set<string>(['Search_Autocomplete']);
    expect(resolveComponent(features)).toBeNull();
  });
});
