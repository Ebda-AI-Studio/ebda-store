'use client';

import { useEffect, useState } from 'react';
import { REVERT_GRACE_MS } from '@ebda/shared';
import { useT } from '../../i18n/useT';
import type { PaymentClaim } from './types';

/** "47h 59m" style countdown to the end of the grace, from the server's `graceUntil`; null once it has passed. */
export function graceCountdown(
  graceUntilIso: string,
  now: number
): { hours: number; minutes: number } | null {
  const ms = new Date(graceUntilIso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { hours: Math.floor(ms / 3_600_000), minutes: Math.floor((ms % 3_600_000) / 60_000) };
}

/** The 48 hours the merchant has, derived from the one constant the server uses (a changed constant changes the copy). */
export const GRACE_HOURS = REVERT_GRACE_MS / 3_600_000;

/**
 * What the automatic InstaPay check did with a claim, in plain words (INSTAPAY-AUTO-1): checking, confirmed automatically, waiting for a
 * person, or - after a "not received" revert - a banner with a live countdown and the two ways to fix it (a correct receipt, or card).
 */
export function AutoConfirmStatus({
  claim,
  onUpload,
  onPayByCard,
  now,
}: {
  claim: PaymentClaim;
  onUpload?: () => void;
  onPayByCard?: () => void;
  /** test seam: a fixed clock */
  now?: number;
}) {
  const t = useT('billing.autoConfirm');
  const [tick, setTick] = useState(() => now ?? Date.now());
  const a = claim.autoConfirm;
  useEffect(() => {
    if (now !== undefined || a?.state !== 'reverted') return;
    const id = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [a?.state, now]);
  if (!a || claim.status === 'rejected') return null;
  if (a.state === 'reverted') {
    const left = a.graceUntil ? graceCountdown(a.graceUntil, now ?? tick) : null;
    return (
      <div
        role="alert"
        className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
        data-testid="auto-revert-banner"
      >
        <p className="font-medium">{t('revertedTitle')}</p>
        <p>
          {t('revertedBody', {
            date: a.graceUntil ? a.graceUntil.slice(0, 16).replace('T', ' ') : '',
          })}
        </p>
        {left ? (
          <p className="text-xs tabular-nums" data-testid="auto-revert-countdown">
            {t('countdown', { hours: String(left.hours), minutes: String(left.minutes) })}
          </p>
        ) : (
          <p className="text-xs">{t('graceOver')}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {onUpload && (
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-sm"
              onClick={onUpload}
            >
              {t('uploadReceipt')}
            </button>
          )}
          {onPayByCard && (
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-sm"
              onClick={onPayByCard}
            >
              {t('payByCard')}
            </button>
          )}
        </div>
      </div>
    );
  }
  const key =
    a.state === 'pending_decision'
      ? 'checking'
      : a.state === 'auto_confirmed'
        ? 'confirmed'
        : 'waiting';
  return (
    <p className="mt-1 text-sm" data-testid={`auto-state-${key}`}>
      {t(key)}
    </p>
  );
}
