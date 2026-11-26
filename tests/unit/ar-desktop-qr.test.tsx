// @vitest-environment jsdom
/** A2b: the desktop QR opens on click, renders a QR image of the product URL, and closes. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

const toDataURL = vi.fn(async (_u: string) => 'data:image/png;base64,AAA');
vi.mock('qrcode', () => ({ default: { toDataURL } }));

const { ArDesktopQr } = await import('../../packages/ui/src/model3d/ArDesktopQr');
const labels = {
  open: 'View in your space',
  title: 'Open it on your phone',
  hint: 'Scan',
  close: 'Close',
};

afterEach(() => {
  cleanup();
  toDataURL.mockClear();
});

describe('ArDesktopQr', () => {
  it('loads the QR library only after the click and encodes the product page', async () => {
    const { container } = render(
      <ArDesktopQr url="https://shop.ebda.app/p/ring" labels={labels} />
    );
    expect(toDataURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
    fireEvent.click(screen.getByText('View in your space'));
    expect(screen.getByRole('group')).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image/)
    );
    expect(toDataURL.mock.calls[0]![0]).toBe('https://shop.ebda.app/p/ring');
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
    fireEvent.click(screen.getByText('View in your space'));
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByRole('group')).toBeNull();
  });
});
