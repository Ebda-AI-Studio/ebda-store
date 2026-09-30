// @vitest-environment jsdom
/**
 * Issues #1929/#1931 — DataTable used to mount BOTH the desktop `<table>`
 * and the mobile card stack unconditionally, hiding one with `hidden
 * md:block` / `md:hidden`. A `display:none` element still participates in
 * native form-constraint validation, so a caller that wraps DataTable in a
 * `<form>` with real `<input>` cells (e.g. purchase-orders/new) had its
 * FIRST invalid control on a phone always be the invisible desktop copy —
 * silent submit failure, no visible error (#1929). It also ran every
 * `column.cell()` twice per row per render (#1931).
 *
 * jsdom has no `window.matchMedia`, so these tests drive the fallback path
 * directly by mocking `window.matchMedia`. This is also the render tests'
 * only way to select which tree DataTable produces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DataTable, type DataTableColumn } from '../DataTable';

afterEach(() => {
  cleanup();
  // @ts-expect-error — test-only cleanup of a test-only global stub.
  delete window.matchMedia;
});

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

interface Row {
  id: string;
  qty: number;
}

function makeColumns(cellSpy: (row: Row) => void): DataTableColumn<Row>[] {
  return [
    {
      header: 'Name',
      primaryOnMobile: true,
      cell: row => {
        cellSpy(row);
        return <span>{row.id}</span>;
      },
    },
    {
      header: 'Qty',
      cell: row => <input type="number" min={1} step={1} defaultValue={row.qty} />,
    },
  ];
}

describe('DataTable renders exactly one tree', () => {
  it('renders only the mobile card stack (no desktop <table> in the DOM) below the breakpoint', () => {
    mockMatchMedia(false);
    const { container } = render(
      <DataTable<Row>
        ariaLabel="Rows"
        columns={makeColumns(() => {})}
        rows={[{ id: 'a', qty: 1 }]}
        rowKey={r => r.id}
      />
    );
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(1);
  });

  it('renders only the desktop <table> (no mobile card stack) at/above the breakpoint', () => {
    mockMatchMedia(true);
    const { container } = render(
      <DataTable<Row>
        ariaLabel="Rows"
        columns={makeColumns(() => {})}
        rows={[{ id: 'a', qty: 1 }]}
        rowKey={r => r.id}
      />
    );
    expect(container.querySelector('table')).not.toBeNull();
    // Exactly one <input> in the whole DOM — not one visible + one
    // display:none copy from a second, hidden tree.
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(1);
  });

  it('calls each cell() exactly once per row, not twice (#1931)', () => {
    mockMatchMedia(false);
    const cellSpy = vi.fn();
    render(
      <DataTable<Row>
        ariaLabel="Rows"
        columns={makeColumns(cellSpy)}
        rows={[
          { id: 'a', qty: 1 },
          { id: 'b', qty: 2 },
        ]}
        rowKey={r => r.id}
      />
    );
    expect(cellSpy).toHaveBeenCalledTimes(2);
  });

  it('a mobile-invalid number input is the ONLY constraint-validation target in the DOM (#1929)', () => {
    // The regression this guards: a hidden (display:none) desktop <input>
    // that still trips native form validation before the merchant's own,
    // visible mobile <input> is ever reached.
    mockMatchMedia(false);
    const { container } = render(
      <form>
        <DataTable<Row>
          ariaLabel="Rows"
          columns={makeColumns(() => {})}
          rows={[{ id: 'a', qty: 1 }]}
          rowKey={r => r.id}
        />
      </form>
    );
    const inputs = container.querySelectorAll('input[type="number"]');
    expect(inputs).toHaveLength(1);
    // The one input that exists is the one a screen or keyboard interaction
    // would reach — there is no earlier, hidden sibling copy of it.
    expect((inputs[0] as HTMLInputElement).checkVisibility?.() ?? true).toBe(true);
  });
});
