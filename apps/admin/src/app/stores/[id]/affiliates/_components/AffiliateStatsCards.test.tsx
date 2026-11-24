// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('./types', async importOriginal => ({
  ...(await importOriginal<object>()),
  formatFils: (n: number) => `fils-${n}`,
}));

import { AffiliateStatsCards } from './AffiliateStatsCards';

afterEach(cleanup);
const base = {
  totalAffiliates: 1,
  activeAffiliates: 1,
  totalReferrals: 0,
  conversions: 0,
  conversionRate: 0,
  commissionPaid: 0,
};

describe('affiliate conversion rate over zero referrals', () => {
  it('shows "—", not 0%', () => {
    render(<AffiliateStatsCards stats={base as never} />);
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });
  it('shows the rate once there are referrals', () => {
    render(
      <AffiliateStatsCards
        stats={{ ...base, totalReferrals: 4, conversions: 1, conversionRate: 25 } as never}
      />
    );
    expect(screen.getByText('25%')).toBeTruthy();
  });
});
