import { describe, it, expect } from 'vitest';
import { inngest } from '../../apps/api/src/lib/inngest/client';

describe('inngest app id', () => {
  it('is ebda-api (renamed; the old app must be archived in the Inngest dashboard)', () => {
    expect((inngest as unknown as { id: string }).id).toBe('ebda-api');
  });
});
