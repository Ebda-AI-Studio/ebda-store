// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, v?: Record<string, unknown>) =>
    v ? `${key}:${Object.values(v).join(',')}` : key,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const apiPut = vi.fn();
vi.mock('../../lib/api', () => ({ apiPut: (...a: unknown[]) => apiPut(...a) }));

import { PackingSlipNoteField } from './PackingSlipNoteField';
import { OrdersBulkBar } from '../../app/stores/[id]/orders/_components/OrdersBulkBar';

afterEach(() => {
  cleanup();
  apiPut.mockReset();
});

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('bulk bar: print packing slips for the selection', () => {
  const props = { isProcessing: false, onMarkPaid: () => {}, onClearSelection: () => {} };
  it('links to the bulk page with exactly the selected ids', () => {
    render(<OrdersBulkBar {...props} storeId="s1" selectedIds={ids(2)} selectedCount={2} />);
    const a = screen.getByText('printBulk:2').closest('a')!;
    expect(a.getAttribute('href')).toBe(`/stores/s1/orders/packing-slips?ids=${ids(2).join(',')}`);
  });
  it('over 100 selected: no link, a note instead', () => {
    render(<OrdersBulkBar {...props} storeId="s1" selectedIds={ids(101)} selectedCount={101} />);
    expect(screen.queryByText(/printBulk/)).toBeNull();
    expect(screen.getByRole('note').textContent).toBe('tooMany');
  });
  it('without a selection nothing renders (existing behaviour)', () => {
    const { container } = render(
      <OrdersBulkBar {...props} storeId="s1" selectedIds={[]} selectedCount={0} />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('packing slip note field', () => {
  it('saves only its key, trimmed, and null when emptied', async () => {
    apiPut.mockResolvedValue({ error: null });
    const onSaved = vi.fn();
    render(<PackingSlipNoteField storeId="s1" value="old" onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('noteTitle'), { target: { value: '  Thanks!  ' } });
    fireEvent.click(screen.getByText('noteSave'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Thanks!'));
    expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1', {
      settings: { packingSlipNote: 'Thanks!' },
    });
    fireEvent.change(screen.getByLabelText('noteTitle'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('noteSave'));
    await waitFor(() =>
      expect(apiPut).toHaveBeenLastCalledWith('/api/v1/stores/s1', {
        settings: { packingSlipNote: null },
      })
    );
  });
  it('shows a failure and does not report it saved', async () => {
    apiPut.mockResolvedValue({ error: { message: 'nope' } });
    const onSaved = vi.fn();
    render(<PackingSlipNoteField storeId="s1" value="" onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('noteTitle'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('noteSave'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('nope'));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
