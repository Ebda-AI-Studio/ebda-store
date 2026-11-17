// @vitest-environment jsdom
/**
 * QA 2026-11-17 N1 / N2 / N3: a derived money figure with an unknown input is UNKNOWN (never revenue, never 0),
 * and chart / cash-flow dates follow the UI language.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { GlKpiCards } from './GlKpiCards';
import { InventorySnapshotCard } from './InventorySnapshotCard';
import { CashflowChart } from './CashflowChart';
import { formatDate } from './types';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) =>
      v ? `${key}:${Object.values(v).join(',')}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});

describe('N1 net income is unknown when cost of goods is unknown', () => {
  it('shows unknown (and the why) for gross profit AND net income, never the revenue', () => {
    render(
      <GlKpiCards
        gl={{ revenue: 485000, cogs: 0, grossProfit: 485000, netIncome: 485000 }}
        periodLabel="p"
      />
    );
    // revenue is the only figure shown as money
    expect(screen.getAllByText('grossProfitUnknown')).toHaveLength(2);
    expect(screen.getAllByText('noCogsBooked')).toHaveLength(2);
    expect(screen.getAllByText(/4,850/)).toHaveLength(1);
  });

  it('shows the figures when cost of goods is booked', () => {
    render(
      <GlKpiCards
        gl={{ revenue: 485000, cogs: 100000, grossProfit: 385000, netIncome: 300000 }}
        periodLabel="p"
      />
    );
    expect(screen.queryByText('grossProfitUnknown')).toBeNull();
    expect(screen.getByText(/3,000/)).toBeTruthy();
  });
});

describe('N2 stock value is unknown or partial, never a silent 0', () => {
  const base = { openBackorderCount: 0, backorderedDemandValue: 0, reorderRulesCount: 0 };

  it('unknown when every stocked product has no cost', () => {
    render(
      <InventorySnapshotCard
        snapshot={{ ...base, stockValue: 0, stockedProducts: 5, uncostedProducts: 5 }}
      />
    );
    expect(screen.getByText('stockValueUnknown')).toBeTruthy();
    expect(screen.getByText('stockValueMissingCost:5')).toBeTruthy();
  });

  it('partial: the value plus how many products it covers', () => {
    render(
      <InventorySnapshotCard
        snapshot={{ ...base, stockValue: 12000, stockedProducts: 5, uncostedProducts: 2 }}
      />
    );
    expect(screen.getByText(/120/)).toBeTruthy();
    expect(screen.getByText('stockValuePartial:3,5')).toBeTruthy();
  });
});

describe('N3 dates follow the UI language', () => {
  it('chart axis label is Arabic in an Arabic admin (no English "Nov")', () => {
    document.documentElement.lang = 'ar';
    expect(formatDate('2026-11-01')).not.toMatch(/Nov/);
  });

  it('cash-flow legend shows localized dates, not raw ISO', () => {
    document.documentElement.lang = 'ar';
    const { container } = render(
      <CashflowChart
        data={[
          { day: '2026-11-11T00:00:00.000Z', net: 100 },
          { day: '2026-11-12T00:00:00.000Z', net: -50 },
        ]}
        periodLabel="p"
      />
    );
    expect(container.textContent).not.toMatch(/2026-11-1[12]/);
  });
});
