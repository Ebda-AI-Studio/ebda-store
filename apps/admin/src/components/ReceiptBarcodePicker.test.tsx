// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RECEIPT_BARCODE_SHAPES } from '@ebda/shared';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
const apiPut = vi.fn();
vi.mock('../lib/api', () => ({ apiPut: (...a: unknown[]) => apiPut(...a) }));

import { ReceiptBarcodePicker } from './ReceiptBarcodePicker';

afterEach(() => {
  cleanup();
  apiPut.mockReset();
});

describe('ReceiptBarcodePicker', () => {
  it('offers plain, off and every approved shape, each with a live preview', () => {
    const { container } = render(
      <ReceiptBarcodePicker storeId="s1" value={undefined} onSaved={() => {}} />
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2 + RECEIPT_BARCODE_SHAPES.length);
    // plain + 24 shapes preview (off has none)
    expect(container.querySelectorAll('svg[aria-label="ORD-48213"]')).toHaveLength(
      1 + RECEIPT_BARCODE_SHAPES.length
    );
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true'); // default plain
    expect(container.querySelectorAll('bdi[dir="ltr"]').length).toBeGreaterThan(0);
  });

  it('QA-89: every tile clips and shrinks its preview so a wide barcode cannot overlap the next tile', () => {
    const { container } = render(
      <ReceiptBarcodePicker storeId="s1" value={undefined} onSaved={() => {}} />
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.className).toContain('min-w-0');
      expect(radio.className).toContain('overflow-hidden');
    }
    for (const c of container.querySelectorAll('bdi[dir="ltr"] > span')) {
      expect(c.className).toContain('[&>svg]:max-w-full');
    }
  });

  it('saves only the one key and reports it to the page', async () => {
    apiPut.mockResolvedValue({ error: null });
    const onSaved = vi.fn();
    render(<ReceiptBarcodePicker storeId="s1" value="plain" onSaved={onSaved} />);
    const save = screen.getByText('saveShape') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByText('shape.palm'));
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('palm'));
    expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1', {
      settings: { receiptBarcodeShape: 'palm' },
    });
  });

  it('shows the error and does not report a failed save', async () => {
    apiPut.mockResolvedValue({ error: { message: 'nope' } });
    const onSaved = vi.fn();
    render(<ReceiptBarcodePicker storeId="s1" value="plain" onSaved={onSaved} />);
    fireEvent.click(screen.getByText('shape.off'));
    fireEvent.click(screen.getByText('saveShape'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('nope'));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
