// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearStoredSignupSlug, readStoredSignupSlug, storeSignupSlug } from '../signup-slug';

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

describe('signup slug carried from a store 404', () => {
  it('keeps a valid slug and reads it back for the store step', () => {
    expect(storeSignupSlug('nosuchstore123')).toBe('nosuchstore123');
    expect(readStoredSignupSlug()).toBe('nosuchstore123');
    clearStoredSignupSlug();
    expect(readStoredSignupSlug()).toBeNull();
  });

  it('ignores reserved, protected, malformed and missing values', () => {
    for (const bad of ['crm', 'paymob', 'ab', 'A B', '<script>', '', null, undefined]) {
      expect(storeSignupSlug(bad as string | null | undefined)).toBeNull();
    }
    expect(readStoredSignupSlug()).toBeNull();
  });
});
