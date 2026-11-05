// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { isRefusedThisSession, rememberRefusal } from './plan-refusal-memo';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    },
  });
});

describe('plan refusal memo', () => {
  it('a remembered 402 skips the call for the rest of the session, per store and endpoint', () => {
    expect(isRefusedThisSession('segments', 's1')).toBe(false);
    rememberRefusal('segments', 's1');
    expect(isRefusedThisSession('segments', 's1')).toBe(true);
    expect(isRefusedThisSession('segments', 's2')).toBe(false);
    expect(isRefusedThisSession('cohorts', 's1')).toBe(false);
  });
});
