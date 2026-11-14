// @vitest-environment jsdom
/** INSTAPAY-AUTO-1 S10: what the merchant sees of the automatic check, the 48 h countdown, and the help articles' parity with the grace constant. */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { REVERT_GRACE_MS } from '@ebda/shared';
import en from '../../i18n/messages/en.json';
import ar from '../../i18n/messages/ar.json';

const locale = vi.hoisted(() => ({ v: 'ar' }));
vi.mock('../../i18n/useT', () => ({
  useT: (ns: string) => (key: string, vars?: Record<string, string>) => {
    const dict = (locale.v === 'ar' ? ar : en) as unknown as Record<string, unknown>;
    const leaf = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);
    return typeof leaf === 'string'
      ? leaf.replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? '')
      : `MISSING:${ns}.${key}`;
  },
}));

import { AutoConfirmStatus, GRACE_HOURS, graceCountdown } from './AutoConfirmStatus';
import type { PaymentClaim } from './types';

afterEach(() => {
  cleanup();
  locale.v = 'ar';
});

const claim = (
  autoConfirm: PaymentClaim['autoConfirm'],
  status: PaymentClaim['status'] = 'pending'
): PaymentClaim =>
  ({
    id: 'c',
    planCode: 'growth',
    billingInterval: 'monthly',
    amountMinor: 5000,
    method: 'instapay',
    paymentReference: 'EBD-1',
    status,
    reviewNote: null,
    createdAt: '2026-11-14T10:00:00Z',
    reviewedAt: null,
    autoConfirm,
  }) as PaymentClaim;

describe('S10 merchant states', () => {
  it('checking, confirmed automatically and waiting for review render in Egyptian Arabic', () => {
    for (const [state, text] of [
      ['pending_decision', 'جاري التأكيد'],
      ['auto_confirmed', 'اتأكدت تلقائيًا'],
      ['needs_human', 'مستنية مراجعة'],
    ] as const) {
      const { unmount } = render(<AutoConfirmStatus claim={claim({ state, graceUntil: null })} />);
      expect(screen.getByText(text)).toBeTruthy();
      unmount();
    }
  });
  it('no automatic check (the switch is off) renders nothing; a rejected claim renders nothing extra', () => {
    const { container } = render(<AutoConfirmStatus claim={claim(null)} />);
    expect(container.textContent).toBe('');
    const r = render(
      <AutoConfirmStatus claim={claim({ state: 'needs_human', graceUntil: null }, 'rejected')} />
    );
    expect(r.container.textContent).toBe('');
  });
  it('after a revert: the banner states the exact sentence, a live countdown from graceUntil and both ways to fix it', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const graceUntil = new Date(now + 47 * 3_600_000 + 59 * 60_000).toISOString();
    const up = vi.fn();
    const card = vi.fn();
    render(
      <AutoConfirmStatus
        claim={claim({ state: 'reverted', graceUntil })}
        now={now}
        onUpload={up}
        onPayByCard={card}
      />
    );
    expect(screen.getByTestId('auto-revert-banner').textContent).toContain(
      'الدفع ما وصلش. ارفع إيصال صح أو ادفع بالكارت قبل'
    );
    expect(screen.getByTestId('auto-revert-countdown').textContent).toContain('47');
    fireEvent.click(screen.getByRole('button', { name: 'ارفع إيصال' }));
    fireEvent.click(screen.getByRole('button', { name: 'ادفع بالكارت' }));
    expect(up).toHaveBeenCalledTimes(1);
    expect(card).toHaveBeenCalledTimes(1);
  });
  it('the countdown is computed from graceUntil and ends', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(graceCountdown(new Date(now + 48 * 3_600_000).toISOString(), now)).toEqual({
      hours: 48,
      minutes: 0,
    });
    expect(graceCountdown(new Date(now + 90_000).toISOString(), now)).toEqual({
      hours: 0,
      minutes: 1,
    });
    expect(graceCountdown(new Date(now).toISOString(), now)).toBeNull();
  });
});

describe('S10 help articles state the grace from the constant', () => {
  const root = path.resolve(__dirname, '../../../../help/content');
  it('GRACE_HOURS is derived from REVERT_GRACE_MS', () => {
    expect(GRACE_HOURS).toBe(REVERT_GRACE_MS / 3_600_000);
  });
  for (const lang of ['ar', 'en'])
    for (const file of ['pay-ebda-with-instapay.mdx'])
      it(`${lang}/${file} mentions the grace in hours and the first-payment limit`, () => {
        const text = fs.readFileSync(path.join(root, lang, file), 'utf8');
        expect(text).toContain(String(REVERT_GRACE_MS / 3_600_000));
        expect(text).toMatch(lang === 'ar' ? /شهر/ : /one month/i);
      });
});
