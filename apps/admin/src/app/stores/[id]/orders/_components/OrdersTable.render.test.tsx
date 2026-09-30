// @vitest-environment jsdom
/**
 * B4a — first real DOM render test in this repo (no jsdom/@testing-library
 * existed here before; every prior "render" assertion used
 * `react-dom/server` static markup, which proves the markup but never a
 * click/change event — see handoff.md "Unproven" note on the agent-key page).
 *
 * Proves the order-list status `<select>` offers exactly the transitions
 * `statusOptionsFor` (types.ts) computes for the row's current status and
 * payment status, and offers NO status control at all when there are no
 * forward transitions.
 *
 * `statusOptionsFor` filters `refunded` out of `VALID_TRANSITIONS[status]`
 * for an UNPAID order, but only for `status === 'pending' || status ===
 * 'cancelled'` — every other status (including `confirmed`) passes
 * `VALID_TRANSITIONS[status]` through unfiltered regardless of payment
 * status. `pending` is exercised directly below, both paid and unpaid,
 * because it previously had no coverage at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

// Minimal i18n stub — there's no prior render test in this repo to mirror,
// so this sets the convention: the translator is the identity function on
// the leaf key, which is all these assertions need (e.g.
// `aria-label={t('actions.updateStatusLabel')}` renders as that literal
// string). `.has()` is required because `OrderStatusBadge` (rendered inside
// every status cell) calls `t.has(status)`.
vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return {
    useTranslations: () => t,
    useLocale: () => 'en',
  };
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: () => {} }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { OrdersTable } from './OrdersTable';
import type { Order } from './types';

afterEach(() => {
  cleanup();
});

function baseOrder(
  overrides: Partial<Order> & Pick<Order, 'id' | 'status' | 'paymentStatus'>
): Order {
  return {
    total: 12000,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

// DataTable renders exactly ONE tree (issues 1929/1931: `useSyncExternalStore`
// over `matchMedia`). jsdom has no `matchMedia`, so it resolves to the MOBILE
// card layout only and a single-order table has exactly one status
// `<select>`. The count is asserted so a regression that re-mounts both trees
// goes red rather than being absorbed; the desktop `<table>` path is not
// exercised by this file.
function statusOptionValues(): string[] {
  const selects = screen.getAllByLabelText('actions.updateStatusLabel') as HTMLSelectElement[];
  expect(selects).toHaveLength(1);
  return within(selects[0])
    .getAllByRole('option')
    .map(o => (o as HTMLOptionElement).value)
    .filter(v => v !== '');
}

function renderTable(orders: Order[]) {
  return render(
    <OrdersTable
      orders={orders}
      isLoading={false}
      hasActiveFilters={false}
      updatingId={null}
      selectedOrders={new Set()}
      onStatusChange={() => {}}
      onMarkPaid={() => {}}
      onOpenInvoice={() => {}}
      onToggleSelected={() => {}}
    />
  );
}

describe('OrdersTable status dropdown (renders the real DOM via jsdom)', () => {
  it('offers exactly the VALID_TRANSITIONS for a confirmed order, refunded included', () => {
    const order = baseOrder({ id: 'order-confirmed', status: 'confirmed', paymentStatus: 'paid' });
    renderTable([order]);

    const optionValues = statusOptionValues();

    // A hardcoded literal, not `VALID_TRANSITIONS.confirmed` (#1967): that
    // comparison is the derived value against itself for `confirmed`, which
    // `statusOptionsFor` never filters — it would stay green even if the
    // transitions map silently dropped an entry.
    expect(optionValues).toEqual(['processing', 'shipped', 'delivered', 'cancelled', 'refunded']);
    expect(optionValues).toContain('refunded');
  });

  it('offers every transition including refunded for a PAID pending order (#1967)', () => {
    // Previously untested entirely: `statusOptionsFor` filters `refunded`
    // for pending/cancelled ONLY when unpaid, so a paid pending order must
    // keep it.
    const order = baseOrder({ id: 'order-pending-paid', status: 'pending', paymentStatus: 'paid' });
    renderTable([order]);

    expect(statusOptionValues()).toEqual([
      'confirmed',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
      'refunded',
    ]);
  });

  it('hides refunded for an UNPAID pending order (#1967)', () => {
    const order = baseOrder({
      id: 'order-pending-unpaid',
      status: 'pending',
      paymentStatus: 'unpaid',
    });
    renderTable([order]);

    const optionValues = statusOptionValues();
    expect(optionValues).toEqual(['confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);
    expect(optionValues).not.toContain('refunded');
  });

  it('offers only Refunded for a PAID cancelled order, and no control for an unpaid one (PR #1897)', () => {
    // A paid order cancelled by staff still owes a refund, so `cancelled ->
    // refunded` is legal for it. An unpaid cancelled order never took money,
    // so statusOptionsFor hides the option and the table renders no control.
    const paidCancelled = baseOrder({
      id: 'order-cancelled-paid',
      status: 'cancelled',
      paymentStatus: 'paid',
    });
    renderTable([paidCancelled]);

    // DataTable renders the row twice (desktop table + mobile card), so every
    // rendered control must offer the same single option.
    const selects = screen.getAllByLabelText('actions.updateStatusLabel') as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      const values = Array.from(select.options)
        .map(o => o.value)
        .filter(Boolean);
      expect(values).toEqual(['refunded']);
    }

    cleanup();

    const unpaidCancelled = baseOrder({
      id: 'order-cancelled-unpaid',
      status: 'cancelled',
      paymentStatus: 'unpaid',
    });
    renderTable([unpaidCancelled]);

    expect(screen.queryByLabelText('actions.updateStatusLabel')).toBeNull();
  });

  it('renders no status control for a refunded order (the only terminal status)', () => {
    renderTable([
      baseOrder({ id: 'order-refunded', status: 'refunded', paymentStatus: 'refunded' }),
    ]);
    expect(screen.queryByLabelText('actions.updateStatusLabel')).toBeNull();
  });

  it('renders exactly one option (refunded) for delivered — positive control proving the dropdown DOES render when transitions exist', () => {
    // Guards against a mutation that always takes the "no dropdown" branch:
    // without this, test 2 above ("no select for cancelled") could pass for
    // the wrong reason (a select that never renders for anyone).
    const order = baseOrder({ id: 'order-delivered', status: 'delivered', paymentStatus: 'paid' });
    renderTable([order]);

    expect(statusOptionValues()).toEqual(['refunded']);
  });
});
