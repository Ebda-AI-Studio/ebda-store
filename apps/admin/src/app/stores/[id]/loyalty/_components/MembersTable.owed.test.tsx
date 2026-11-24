// @vitest-environment jsdom
/**
 * #631: a member whose refund took back points they had already spent has a NEGATIVE balance. The table shows 0 and an
 * "owes N points" line in both locales, never a bare negative number (the minus lands on the wrong side in Arabic).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../../../i18n/messages/en.json';
import ar from '../../../../../i18n/messages/ar.json';
import { MembersTable } from './MembersTable';

const member = (points: number) => ({
  id: 'lp1',
  customerId: 'c1',
  points,
  totalEarned: 0,
  totalRedeemed: 700,
  tier: 'bronze',
  customer: { id: 'c1', email: 'a@b.c', firstName: 'Mona', lastName: 'A' },
});

const renderIn = (locale: 'en' | 'ar', points: number) =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en}>
      <MembersTable
        members={[member(points)]}
        tierFilter="all"
        onTierFilterChange={() => undefined}
        onAwardClick={() => undefined}
      />
    </NextIntlClientProvider>
  );

afterEach(cleanup);

describe('MembersTable negative balance (#631)', () => {
  it.each(['en', 'ar'] as const)('%s: shows "owes" with no bare minus sign', locale => {
    renderIn(locale, -5000);
    const owed = screen.getAllByTestId('points-owed')[0];
    expect(owed.textContent).toMatch(locale === 'ar' ? /عليه/ : /Owes/);
    expect(owed.textContent).toMatch(/5[,٬]?000|٥[,٬]?٠٠٠/);
    expect(document.body.textContent).not.toMatch(/-\s?5[,٬]?000|−5/);
  });
  it('a normal balance shows no owed line', () => {
    renderIn('en', 300);
    expect(screen.queryByTestId('points-owed')).toBeNull();
  });
});
