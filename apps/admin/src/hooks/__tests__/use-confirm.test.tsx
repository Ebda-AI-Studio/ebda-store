// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@ebda/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Modal: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

import { ConfirmHost, requestConfirm } from '../useConfirm';

const opts = { object: 'المنتج «قميص»', consequence: 'هيتمسح نهائي.', confirmLabel: 'امسح المنتج' };

describe('useConfirm / ConfirmHost', () => {
  it('shows the named object, consequence and outcome button; resolves true on confirm', async () => {
    render(<ConfirmHost />);
    let result: Promise<boolean>;
    act(() => {
      result = requestConfirm(opts);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(opts.object)).toBeTruthy();
    expect(screen.getByText(opts.consequence)).toBeTruthy();
    fireEvent.click(screen.getByText('امسح المنتج'));
    await expect(result!).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves false on cancel', async () => {
    render(<ConfirmHost />);
    let result: Promise<boolean>;
    act(() => {
      result = requestConfirm(opts);
    });
    fireEvent.click(screen.getByText('cancel'));
    await expect(result!).resolves.toBe(false);
  });

  it('a second request cancels the first', async () => {
    render(<ConfirmHost />);
    let first: Promise<boolean>;
    act(() => {
      first = requestConfirm(opts);
    });
    act(() => {
      void requestConfirm({ ...opts, object: 'تاني' });
    });
    await expect(first!).resolves.toBe(false);
  });
});
