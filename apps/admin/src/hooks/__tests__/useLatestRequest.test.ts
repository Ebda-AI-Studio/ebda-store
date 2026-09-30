// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLatestRequest } from '../useLatestRequest';

describe('useLatestRequest (issue 2234)', () => {
  it('only the newest request may write — an older one resolving last is dropped', () => {
    const { result } = renderHook(() => useLatestRequest());
    const a = result.current(); // e.g. page=3&segment=vip
    const b = result.current(); // page=1&segment=vip
    // b resolves first, then a: a must be ignored.
    expect(b()).toBe(true);
    expect(a()).toBe(false);
  });

  it('is stable across renders', () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
