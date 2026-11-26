import { describe, it, expect, vi } from 'vitest';

vi.mock('./redis.service', () => ({ redis: { acquireLock: async () => true } }));

import { runWithWaitUntil } from '../cf/bindings';
import { sendAlert } from './alerts.service';

// 47 call sites `void sendAlert(..)` (P1 "Refund needs review", webhook + orphaned-invoice alerts). On a Worker an
// unawaited promise dies with the response; inFlightAlerts only serves a Node shutdown drain.
describe('sendAlert inside a Worker request', () => {
  it('hands the in-flight send to waitUntil and still returns it', async () => {
    const kept: Array<Promise<unknown>> = [];
    const p = runWithWaitUntil(
      w => kept.push(w),
      () => sendAlert({ level: 'p1', scope: 'platform', source: 'test', title: 't', body: 'b' })
    );
    expect(kept).toHaveLength(1);
    await expect(p).resolves.toBeTypeOf('string');
    await kept[0];
  });
});
