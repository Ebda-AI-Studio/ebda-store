// @vitest-environment jsdom
/**
 * Issue 2357: the tax page used to explain priority/compound override
 * semantics the charge never had. It now states the real rule (every active
 * rate applies, summed — ruling TAX-1) and shows the combined figure the
 * charge applies, computed with the same hundredths arithmetic as
 * `resolveActiveTaxRate` (apps/api/src/lib/order-tax.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, vals?: Record<string, unknown>) =>
      vals ? `${key}:${JSON.stringify(vals)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { TaxInfoBox } from './TaxInfoBox';
import { combinedActiveRate } from './types';

afterEach(cleanup);

describe('combinedActiveRate', () => {
  it('sums active rates only, exactly (0.1 + 0.2 = 0.3)', () => {
    expect(
      combinedActiveRate([
        { rate: 5, isActive: true },
        { rate: 2, isActive: true },
        { rate: 15, isActive: false },
      ])
    ).toBe(7);
    expect(
      combinedActiveRate([
        { rate: 0.1, isActive: true },
        { rate: 0.2, isActive: true },
      ])
    ).toBe(0.3);
    expect(combinedActiveRate([])).toBe(0);
  });
});

describe('TaxInfoBox', () => {
  it('shows the summed rate the charge applies when tax is on', () => {
    render(
      <TaxInfoBox
        taxEnabled
        activeRates={[
          { rate: 5, isActive: true },
          { rate: 2, isActive: true },
        ]}
      />
    );
    expect(screen.getByTestId('tax-combined-rate').textContent).toBe('combined:{"rate":7}');
    expect(screen.queryByText(/priority|compound/i)).toBeNull();
  });

  it('says nothing is charged when tax is off, whatever rates exist', () => {
    render(<TaxInfoBox taxEnabled={false} activeRates={[{ rate: 5, isActive: true }]} />);
    expect(screen.getByTestId('tax-combined-rate').textContent).toBe('off');
  });
});
