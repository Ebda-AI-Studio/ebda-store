// @vitest-environment jsdom
/**
 * B4a — first real DOM render test in this repo (no jsdom/@testing-library
 * existed here before; every prior "render" assertion used
 * `react-dom/server` static markup, which proves the markup but never a
 * click/change event — see handoff.md "Unproven" note on the agent-key page).
 *
 * Proves the order-list status `<select>` offers exactly the transitions
 * `VALID_TRANSITIONS` declares for the row's current status, and offers NO
 * status control at all for a status with no forward transitions.
 *
 * SCOPE NOTE: the task spec asked this to prove `statusOptionsFor` gates
 * "Refunded" behind `paymentStatus === 'paid'` for a cancelled order. That
 * function lives on branch `fix/pre-clone-batch-a` (added there, confirmed
 * via `git show origin/fix/pre-clone-batch-a:.../types.ts`) and is NOT yet
 * on `origin/main` — this worktree branches off `origin/main`, where
 * `types.ts` only exports the plain `VALID_TRANSITIONS` map and
 * `OrdersTable` reads it directly with no payment-status gating at all.
 * Per the task's own fallback instruction, this file tests the CURRENT
 * `VALID_TRANSITIONS` behaviour instead: on main, `cancelled` is not even a
 * key in the map, so a cancelled order gets `transitions.length === 0` and
 * renders no dropdown — "never offers Refunded to a cancelled order" holds
 * today because it offers no status change at all. When batch-a's
 * `statusOptionsFor` lands on main, this test should be extended to cover
 * the paid/unpaid split it introduces.
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
import { VALID_TRANSITIONS, type Order } from './types';

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

// DataTable renders BOTH the desktop `<table>` and the mobile card layout
// into the DOM at once (a CSS media query hides one — jsdom doesn't apply
// CSS), so the status `<select>` for a given order exists twice. Assert
// every instance agrees, then return the shared option list.
function statusOptionValues(): string[] {
  const selects = screen.getAllByLabelText('actions.updateStatusLabel') as HTMLSelectElement[];
  const lists = selects.map(select =>
    within(select)
      .getAllByRole('option')
      .map(o => (o as HTMLOptionElement).value)
      .filter(v => v !== '')
  );
  for (const list of lists) {
    expect(list).toEqual(lists[0]);
  }
  return lists[0];
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

    expect(optionValues).toEqual(VALID_TRANSITIONS.confirmed);
    expect(optionValues).toContain('refunded');
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
