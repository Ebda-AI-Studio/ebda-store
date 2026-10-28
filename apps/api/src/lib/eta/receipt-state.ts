import type { EtaReceiptStatus } from '@ebda/shared';
import type { SubmissionVerdict, SubmitOutcome } from './client';

/**
 * Pure state transitions for an e-receipt row (fail fast, never orphan, Ruling ETA-1):
 *   queued/retrying --submit--> submitted --verdict--> accepted | rejected
 *   any transient failure   --> retrying (nextAttemptAt) until deadlineAt, then `late`
 *   any permanent failure   --> failed / rejected (terminal, reason stored)
 * No row stays `queued`/`retrying` without a nextAttemptAt or past its deadline: the sweep
 * (due rows) and the `late` alert cover both.
 */
export interface RowState {
  uuid: string | null;
  attempts: number;
  deadlineAt: Date | null;
}
export interface Patch {
  status: EtaReceiptStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  submissionUuid?: string;
  longId?: string;
  acceptedAt?: Date;
}

export const VERDICT_POLL_MS = 60_000;

/** 30 s, 60 s, 2 m ... capped at 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function isPastDeadline(row: RowState, now: Date): boolean {
  return !!row.deadlineAt && now.getTime() > row.deadlineAt.getTime();
}

function retryPatch(row: RowState, now: Date, reason: string, afterMs: number | null): Patch {
  const attempts = row.attempts + 1;
  const delay = afterMs ?? backoffMs(attempts);
  const next = new Date(now.getTime() + delay);
  if (row.deadlineAt && next.getTime() > row.deadlineAt.getTime())
    return {
      status: 'late',
      attempts,
      nextAttemptAt: null,
      errorCode: reason,
      errorMessage: 'the 24 h submission window ran out',
    };
  return {
    status: 'retrying',
    attempts,
    nextAttemptAt: next,
    errorCode: reason,
    errorMessage: null,
  };
}

export function applySubmitOutcome(row: RowState, o: SubmitOutcome, now: Date): Patch {
  if (o.kind === 'retry') return retryPatch(row, now, o.reason, o.afterMs);
  const attempts = row.attempts + 1;
  if (o.kind === 'fatal')
    return {
      status: 'failed',
      attempts,
      nextAttemptAt: null,
      errorCode: o.code,
      errorMessage: o.message,
    };
  const rej = o.rejected.find(r => r.uuid === row.uuid);
  if (rej) {
    const msg = typeof rej.error === 'string' ? rej.error : (rej.error?.message ?? null);
    return {
      status: 'rejected',
      attempts,
      nextAttemptAt: null,
      errorCode: 'rejected_on_submit',
      errorMessage: msg?.slice(0, 300) ?? null,
    };
  }
  return {
    status: 'submitted',
    attempts,
    nextAttemptAt: new Date(now.getTime() + VERDICT_POLL_MS),
    errorCode: null,
    errorMessage: null,
    submissionUuid: o.submissionUuid,
  };
}

export function applyVerdict(row: RowState, v: SubmissionVerdict, now: Date): Patch {
  if (v.kind === 'retry') return pollAgain(row, now, v.reason, v.afterMs);
  if (v.kind === 'fatal')
    return {
      status: 'failed',
      attempts: row.attempts + 1,
      nextAttemptAt: null,
      errorCode: v.code,
      errorMessage: 'ETA refused the status check',
    };
  if (v.kind === 'in_progress') return pollAgain(row, now, 'in_progress', null);
  const mine = v.receipts.find(r => r.uuid === row.uuid);
  if (!mine) return pollAgain(row, now, 'not_listed_yet', null);
  const attempts = row.attempts + 1;
  if (mine.status === 'Valid')
    return {
      status: 'accepted',
      attempts,
      nextAttemptAt: null,
      errorCode: null,
      errorMessage: null,
      longId: mine.longId,
      acceptedAt: now,
    };
  return {
    status: 'rejected',
    attempts,
    nextAttemptAt: null,
    errorCode: mine.status === 'Cancelled' ? 'cancelled' : (mine.errorCode ?? 'invalid'),
    errorMessage: null,
  };
}

function pollAgain(row: RowState, now: Date, reason: string, afterMs: number | null): Patch {
  const attempts = row.attempts + 1;
  if (isPastDeadline(row, now))
    return {
      status: 'late',
      attempts,
      nextAttemptAt: null,
      errorCode: reason,
      errorMessage: 'no verdict inside the 24 h window',
    };
  const delay = afterMs ?? Math.min(backoffMs(Math.max(1, attempts - 1)), 10 * 60_000);
  return {
    status: 'submitted',
    attempts,
    nextAttemptAt: new Date(now.getTime() + Math.max(delay, VERDICT_POLL_MS)),
    errorCode: reason,
    errorMessage: null,
  };
}
