// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/stores/store-1',
  useSearchParams: () => new URLSearchParams(),
}));

import { EmptyState } from './EmptyState';
import { EmptyProductsState } from '../app/stores/[id]/products/_components/EmptyProductsState';
import { EmptyOrdersState } from '../app/stores/[id]/orders/_components/EmptyOrdersState';
import { CouponsTable } from '../app/stores/[id]/coupons/_components/CouponsTable';
import { AffiliatesTable } from '../app/stores/[id]/affiliates/_components/AffiliatesTable';
import { AbandonedCartsTable } from '../app/stores/[id]/abandoned-carts/_components/AbandonedCartsTable';
import { AbandonmentsTable } from '../app/stores/[id]/payment-abandonments/_components/AbandonmentsTable';
import { CategoryTable } from '../app/stores/[id]/categories/CategoryTable';

afterEach(cleanup);

const meta = { page: 1, limit: 20, total: 0, totalPages: 0 } as never;

describe('EmptyState', () => {
  it('renders title, description, hint, primary + secondary CTA and help link', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon="M0 0"
        title="No coupons"
        description="Why"
        hint="Hint"
        action={{ label: 'Create', onClick }}
        secondaryAction={{ label: 'Other', href: '/x' }}
        helpLink={{ label: 'Learn', href: '/help' }}
      />
    );
    expect(screen.getByText('No coupons')).toBeTruthy();
    expect(screen.getByText('Why')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Other' }).getAttribute('href')).toBe('/x');
    expect(screen.getByRole('link', { name: 'Learn' }).getAttribute('href')).toBe('/help');
  });
  it('renders no CTA when none is given (filtered no-match state)', () => {
    render(<EmptyState icon="M0 0" title="No match" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('every list screen renders the shared empty state with its CTA', () => {
  it('products', () => {
    render(
      <EmptyProductsState storeId="s" hasActiveFilters={false} listUrl="/stores/s/products" />
    );
    expect(screen.getByTestId('empty-state')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'addProduct' }).getAttribute('href')).toContain(
      '/stores/s/products/new'
    );
  });
  it('orders', () => {
    render(<EmptyOrdersState hasActiveFilters={false} />);
    expect(screen.getByRole('link', { name: 'addProduct' })).toBeTruthy();
  });
  it('coupons', () => {
    const onCreateFirst = vi.fn();
    render(
      <CouponsTable
        coupons={[]}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggleActive={() => {}}
        onCreateFirst={onCreateFirst}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'createFirst' }));
    expect(onCreateFirst).toHaveBeenCalledOnce();
  });
  it('affiliates', () => {
    const onInvite = vi.fn();
    render(
      <AffiliatesTable
        storeId="s"
        affiliates={[]}
        meta={meta}
        statusFilter="all"
        page={1}
        saving={false}
        onStatusFilterChange={() => {}}
        onPageChange={() => {}}
        onStatusAction={() => {}}
        onOpenPayout={() => {}}
        onInvite={onInvite}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'empty.invite' }));
    expect(onInvite).toHaveBeenCalledOnce();
  });
  it('abandoned carts', () => {
    render(
      <AbandonedCartsTable
        records={[]}
        meta={meta}
        statusFilter="all"
        page={1}
        onStatusFilterChange={() => {}}
        onPageChange={() => {}}
      />
    );
    expect(screen.getByRole('link', { name: 'emptyOrdersLink' })).toBeTruthy();
  });
  it('payment abandonments', () => {
    render(
      <AbandonmentsTable storeId="s" records={[]} meta={meta} page={1} onPageChange={() => {}} />
    );
    expect(screen.getByRole('link', { name: 'emptyAction' }).getAttribute('href')).toBe(
      '/stores/s/payment-settings'
    );
  });
  it('categories', () => {
    const onAddFirst = vi.fn();
    render(
      <CategoryTable
        categories={[]}
        isLoading={false}
        deletingId={null}
        storeId="s"
        onEdit={() => {}}
        onDelete={() => {}}
        onAddFirst={onAddFirst}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'addFirst' }));
    expect(onAddFirst).toHaveBeenCalledOnce();
  });
});
