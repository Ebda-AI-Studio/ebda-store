/** A re-fired cron tick or store alarm (same deterministic event id) is a no-op, not an error. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { startJob } from '@api/lib/jobs/start';

const create = vi.fn(async (_o: { id: string; params: unknown }) => ({ id: 'i' }));
afterEach(() => {
  clearCfBindings();
  create.mockClear();
});

describe('startJob duplicate instance', () => {
  const def = {
    id: 'accounting-daily-close',
    options: { id: 'accounting-daily-close' },
    handler: async () => undefined,
  };
  const bind = () =>
    setCfBindings({
      JOBS_WORKFLOW: { create },
      JOBS_QUEUE: { send: async () => undefined },
    });

  it('an alarm event id that already exists returns duplicate (no idempotency option needed)', async () => {
    bind();
    create.mockRejectedValueOnce(new Error('instance.already_exists'));
    await expect(
      startJob(def as never, {
        id: 'alarm-accounting-daily-close-s1-123',
        name: 'inngest/scheduled.timer',
      })
    ).resolves.toBe('duplicate');
  });

  it('any other start error still throws', async () => {
    bind();
    create.mockRejectedValueOnce(new Error('workflows down'));
    await expect(startJob(def as never, { id: 'e1', name: 'x/y' })).rejects.toThrow(
      'workflows down'
    );
  });
});
