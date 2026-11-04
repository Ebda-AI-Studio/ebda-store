/**
 * Ruling NZ-AN-1 (review): during the `ai-usage` cutover freeze the usage row of an AI call that already ran is NEVER dropped.
 * The routed write answers 503 PLATFORM_FAMILY_FROZEN; recordUsage then writes the row to Postgres (the source until the flip)
 * with an idempotent raw statement, and the cutover script copies those rows into D1 after the thaw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  exec: vi.fn(async () => 1),
  warn: vi.fn(),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: {
      aiUsage: { create: h.create },
      $executeRaw: (...a: unknown[]) => h.exec(...a),
    },
  })
);
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/savepoint', () => ({ withSavepoint: <T>(fn: () => T) => fn() }));

import { recordUsage } from '@api/services/ai.service';

const frozen = Object.assign(new Error('frozen'), { code: 'PLATFORM_FAMILY_FROZEN' });

beforeEach(() => {
  h.create.mockReset();
  h.exec.mockClear();
  h.warn.mockClear();
});

describe('recordUsage during the ai-usage freeze', () => {
  it('writes the row to Postgres instead of dropping it', async () => {
    h.create.mockRejectedValue(frozen);
    await recordUsage('s1', 'seo' as never, 10, 5, false);
    expect(h.exec).toHaveBeenCalledTimes(1);
    const [, id, store] = h.exec.mock.calls[0] as unknown as unknown[];
    expect(typeof id).toBe('string');
    expect(store).toBe('s1');
    expect(h.warn.mock.calls.map(c => c[1])).not.toContain('Failed to record AI usage');
  });

  it('does not use the fallback when the routed write works, and still swallows another failure', async () => {
    h.create.mockResolvedValue({});
    await recordUsage('s1', 'seo' as never, 1, 1, false);
    expect(h.exec).not.toHaveBeenCalled();
    h.create.mockRejectedValue(new Error('boom'));
    await recordUsage('s1', 'seo' as never, 1, 1, false);
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.warn.mock.calls.map(c => c[1])).toContain('Failed to record AI usage');
  });
});
