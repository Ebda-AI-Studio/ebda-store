/** SWEEP-BOUND-2: the abandoned-cart sweep is capped per store and per tick. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({ prisma: {} })
);

const src = readFileSync(
  join(__dirname, '../../apps/api/src/services/abandoned-cart.service.ts'),
  'utf8'
);

describe('abandoned-cart sweep is bounded (SWEEP-BOUND-2)', () => {
  it('candidate loaders take a cap on both backends', () => {
    expect(src.match(/take: CANDIDATE_CAP_PER_STORE/g)?.length).toBe(2);
  });
  it('due-reminder reads take a per-store cap, oldest due first', () => {
    expect(src.match(/take: REMINDER_CAP_PER_STORE/g)?.length).toBe(2);
    expect(src.match(/orderBy: \{ nextStepAt: 'asc' \}/g)?.length).toBe(2);
  });
  it('the merged due list is capped per tick, oldest first', async () => {
    const { capDueReminders, REMINDER_CAP_PER_TICK } =
      await import('../../apps/api/src/services/abandoned-cart.service');
    const rows = Array.from({ length: REMINDER_CAP_PER_TICK + 50 }, (_, i) => ({
      id: i,
      nextStepAt: new Date(1_000_000 - i * 1000),
    }));
    const out = capDueReminders(rows);
    expect(out).toHaveLength(REMINDER_CAP_PER_TICK);
    expect(out[0].id).toBe(rows.length - 1); // the oldest due
  });
});
