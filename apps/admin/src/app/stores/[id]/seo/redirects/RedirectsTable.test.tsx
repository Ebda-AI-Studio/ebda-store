// @vitest-environment jsdom
/**
 * #903: SlugRedirect had no admin UI surface — a merchant could not see or
 * remove a spuriously-captured bulk-import alias, or a stale redirect
 * blocking an old slug being re-purposed. This renders the pure table
 * component the redirects page is built on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RedirectsTable, type SlugRedirectRow } from './RedirectsTable';

afterEach(() => {
  cleanup();
});

const t = (key: string) => key;

// DataTable renders exactly ONE tree (issues 1929/1931: `useSyncExternalStore`
// over `matchMedia`). jsdom has no `matchMedia`, so it resolves to the MOBILE
// card layout only — the desktop <table> path is not exercised here. Counts
// below are exact so a regression that re-mounts both trees goes red instead
// of being absorbed by a `length > 0`.

function row(overrides: Partial<SlugRedirectRow> = {}): SlugRedirectRow {
  return {
    id: 'redir-1',
    entityType: 'PRODUCT',
    fromSlug: 'old-slug',
    toSlug: 'new-slug',
    createdAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('RedirectsTable', () => {
  it('renders fromSlug -> toSlug and entity type for each row', () => {
    render(
      <RedirectsTable
        rows={[row()]}
        deletingId={null}
        onDelete={() => {}}
        t={t}
        ariaLabel="Slug Redirects"
      />
    );
    expect(screen.getAllByText('old-slug')).toHaveLength(1);
    expect(screen.getAllByText('new-slug')).toHaveLength(1);
    expect(screen.getAllByText('PRODUCT')).toHaveLength(1);
  });

  it('shows the empty state when there are no rows', () => {
    render(
      <RedirectsTable
        rows={[]}
        deletingId={null}
        onDelete={() => {}}
        t={t}
        ariaLabel="Slug Redirects"
      />
    );
    expect(screen.getByText('redirectsEmpty')).toBeTruthy();
    expect(screen.queryByText('old-slug')).toBeNull();
  });

  it('calls onDelete with the row id when its delete button is clicked', () => {
    const onDelete = vi.fn();
    render(
      <RedirectsTable
        rows={[row({ id: 'redir-42' })]}
        deletingId={null}
        onDelete={onDelete}
        t={t}
        ariaLabel="Slug Redirects"
      />
    );
    const buttons = screen.getAllByText('redirectsDelete');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('redir-42');
  });

  it('disables only the row currently being deleted', () => {
    render(
      <RedirectsTable
        rows={[row({ id: 'a' }), row({ id: 'b', fromSlug: 'other-slug' })]}
        deletingId="a"
        onDelete={() => {}}
        t={t}
        ariaLabel="Slug Redirects"
      />
    );
    const buttons = screen.getAllByRole('button');
    // The row mid-delete shows the pending ellipsis, not the label, and is
    // disabled; the other row's button stays enabled.
    expect(buttons.some(b => b.textContent === '…' && (b as HTMLButtonElement).disabled)).toBe(
      true
    );
    expect(
      buttons.some(b => b.textContent === 'redirectsDelete' && !(b as HTMLButtonElement).disabled)
    ).toBe(true);
  });
});
