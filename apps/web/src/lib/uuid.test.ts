import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUuid } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('randomUuid', () => {
  it('uses crypto.randomUUID when the browser has it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'native-id' });
    expect(randomUuid()).toBe('native-id');
  });

  it('builds a v4 UUID from getRandomValues in an insecure context (no randomUUID)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(255) });
    expect(randomUuid()).toMatch(V4);
  });
});
