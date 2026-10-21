import { describe, it, expect, vi } from 'vitest';

// `wa-bridge-auth.ts` imports `@ebda/database` (Prisma) at module scope —
// mocked here the same way tests/unit/contract-wbs-bridge.test.ts does, so
// this file can exercise `secretsMatch` without a real DB/Prisma build.
vi.mock('@ebda/database', () => ({ withStore: vi.fn(), runInStoreScope: vi.fn() }));
vi.mock('../../apps/api/src/lib/definer', () => ({ wbsBridgeKeys: vi.fn() }));
vi.mock('../../apps/api/src/services/encryption.service', () => ({
  encryption: { decrypt: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { secretsMatch } = await import('@api/middleware/wa-bridge-auth');

// `secretsMatch` must behave exactly like `===` for every input — the
// constant-time property is about WHEN it returns, not WHAT it returns —
// so these are plain correctness tests. The timing property itself isn't
// something a unit test can assert reliably; it's enforced by hashing both
// sides to a fixed-length digest and comparing with `crypto.timingSafeEqual`
// instead of a raw string `===` (see the function's own comment).
describe('secretsMatch', () => {
  it('matches identical strings', () => {
    expect(secretsMatch('wbs_live_abc123', 'wbs_live_abc123')).toBe(true);
  });

  it('rejects a completely different string', () => {
    expect(secretsMatch('wbs_live_abc123', 'wbs_live_xyz999')).toBe(false);
  });

  it('rejects a same-length near-miss (last char differs)', () => {
    expect(secretsMatch('wbs_live_abc123', 'wbs_live_abc124')).toBe(false);
  });

  it('rejects a shorter string that is a prefix of the real one', () => {
    expect(secretsMatch('wbs_live_abc123', 'wbs_live_abc')).toBe(false);
  });

  it('rejects a longer string that has the real one as a prefix', () => {
    expect(secretsMatch('wbs_live_abc123', 'wbs_live_abc123_extra')).toBe(false);
  });

  it('rejects the empty string against a real secret', () => {
    expect(secretsMatch('wbs_live_abc123', '')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(secretsMatch('wbs_live_abc123', 'WBS_LIVE_ABC123')).toBe(false);
  });
});
