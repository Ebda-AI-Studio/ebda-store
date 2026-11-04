// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { EmptyProductsState } from './EmptyProductsState';

afterEach(cleanup);

describe('EmptyProductsState', () => {
  it('an empty default Active view hints at drafts (an all-drafts store is not "add your first product")', () => {
    const onShowDrafts = vi.fn();
    render(
      <EmptyProductsState
        storeId="s1"
        hasActiveFilters={false}
        listUrl="/stores/s1/products"
        onShowDrafts={onShowDrafts}
      />
    );
    expect(screen.getByText('titleActiveOnly')).toBeTruthy();
    expect(screen.queryByText('title')).toBeNull();
    fireEvent.click(screen.getByText('showDrafts'));
    expect(onShowDrafts).toHaveBeenCalledTimes(1);
  });

  it('a truly empty catalog elsewhere (no switch offered) still reads "add your first product"', () => {
    render(
      <EmptyProductsState storeId="s1" hasActiveFilters={false} listUrl="/stores/s1/products" />
    );
    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.queryByText('showDrafts')).toBeNull();
  });
});
