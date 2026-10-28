import { describe, it, expect } from 'vitest';
import { applySubmitOutcome, applyVerdict, backoffMs } from '@api/lib/eta/receipt-state';

const now = new Date('2026-10-26T10:00:00Z');
const row = (o = {}) => ({
  uuid: 'U',
  attempts: 0,
  deadlineAt: new Date('2026-10-27T10:00:00Z'),
  ...o,
});

describe('receipt state machine', () => {
  it('backs off 30s doubling, capped at 30 min', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([30000, 60000, 120000]);
    expect(backoffMs(20)).toBe(1_800_000);
  });
  it('a transient failure retries with a nextAttemptAt (never an orphan queued row)', () => {
    const p = applySubmitOutcome(row(), { kind: 'retry', reason: 'throttled', afterMs: 7000 }, now);
    expect(p.status).toBe('retrying');
    expect(p.nextAttemptAt?.getTime()).toBe(now.getTime() + 7000);
  });
  it('runs out the 24 h window -> late, no further attempts', () => {
    const p = applySubmitOutcome(
      row({ deadlineAt: new Date(now.getTime() + 1000) }),
      { kind: 'retry', reason: 'network', afterMs: null },
      now
    );
    expect(p).toMatchObject({ status: 'late', nextAttemptAt: null });
  });
  it('fatal -> failed with the code', () => {
    expect(
      applySubmitOutcome(row(), { kind: 'fatal', code: 'BadStructure', message: 'x' }, now)
    ).toMatchObject({ status: 'failed', errorCode: 'BadStructure', nextAttemptAt: null });
  });
  it('202 means submitted, not accepted; own uuid in rejected is terminal', () => {
    const ok = applySubmitOutcome(
      row(),
      {
        kind: 'ok',
        submissionUuid: 'S',
        accepted: [{ uuid: 'U', longId: 'L', receiptNumber: 'R' }],
        rejected: [],
      },
      now
    );
    expect(ok).toMatchObject({ status: 'submitted', submissionUuid: 'S' });
    const bad = applySubmitOutcome(
      row(),
      {
        kind: 'ok',
        submissionUuid: 'S',
        accepted: [],
        rejected: [{ uuid: 'U', receiptNumber: 'R', error: 'dup' }],
      },
      now
    );
    expect(bad.status).toBe('rejected');
  });
  it('verdict Valid -> accepted with longId; Invalid -> rejected with ETA code', () => {
    expect(
      applyVerdict(
        row(),
        { kind: 'done', receipts: [{ uuid: 'U', status: 'Valid', longId: 'L' }] },
        now
      )
    ).toMatchObject({ status: 'accepted', longId: 'L' });
    expect(
      applyVerdict(
        row(),
        { kind: 'done', receipts: [{ uuid: 'U', status: 'Invalid', errorCode: 'CV307' }] },
        now
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'CV307' });
  });
  it('InProgress keeps polling until the deadline, then late', () => {
    expect(applyVerdict(row(), { kind: 'in_progress' }, now).status).toBe('submitted');
    expect(
      applyVerdict(row({ deadlineAt: new Date(now.getTime() - 1) }), { kind: 'in_progress' }, now)
        .status
    ).toBe('late');
  });
});
