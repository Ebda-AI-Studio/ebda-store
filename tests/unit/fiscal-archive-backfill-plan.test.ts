import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script
import { plan, DIRECTORY_SQL } from '../../scripts/ops/fiscal-archive-backfill-dry-run.mjs';

describe('fiscal archive backfill dry run (read-only)', () => {
  it('lists only retired DO stores without a manifest, and its SQL is a SELECT', () => {
    expect(DIRECTORY_SQL).toMatch(/^SELECT /);
    expect(DIRECTORY_SQL).not.toMatch(/\b(UPDATE|DELETE|INSERT|DROP)\b/i);
    const p = plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['b']);
    expect(p).toMatchObject({ total: 3, archived: 1 });
    expect(p.todo.map((s: { id: string }) => s.id)).toEqual(['a', 'c']);
  });
});
