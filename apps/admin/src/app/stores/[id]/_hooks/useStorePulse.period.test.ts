// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePulsePeriod } from './useStorePulse';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('usePulsePeriod (D3)', () => {
  it('defaults to 7 days', () => {
    expect(renderHook(() => usePulsePeriod()).result.current[0]).toBe('last_7');
  });
  it('keeps the chosen period across a remount (an EN/AR switch reloads the page)', () => {
    const first = renderHook(() => usePulsePeriod());
    act(() => first.result.current[1]('last_30'));
    first.unmount();
    expect(renderHook(() => usePulsePeriod()).result.current[0]).toBe('last_30');
  });
  it('ignores a stored value that is not a known period', () => {
    sessionStorage.setItem('ebda.dashboard.pulsePeriod', 'bogus');
    expect(renderHook(() => usePulsePeriod()).result.current[0]).toBe('last_7');
  });
});
