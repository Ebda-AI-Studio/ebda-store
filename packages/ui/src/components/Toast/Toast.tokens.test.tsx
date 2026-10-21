// @vitest-environment jsdom
/**
 * IA-03 / IA-06 (W4): toasts were mint green with a 16px radius (a hue in none of the looks) and
 * could not offer an action, so removing a cart line had no undo. Toasts now draw on the theme
 * tokens and the store radius, and take an optional action button.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from './index';

afterEach(cleanup);

function Fire({ onUndo }: { onUndo?: () => void }) {
  const toast = useToast();
  useEffect(() => {
    toast.addToast({
      type: 'success',
      title: 'تمت إزالة عباية كتان',
      action: onUndo ? { label: 'تراجع', onClick: onUndo } : undefined,
    });
  }, []);
  return null;
}

describe('Toast', () => {
  it('no palette hues, the store radius', () => {
    const { container } = render(
      <ToastProvider>
        <Fire />
      </ToastProvider>
    );
    const html = container.ownerDocument.body.innerHTML;
    expect(html).not.toMatch(/(?:bg|text|border)-(?:green|red|yellow|blue)-\d/);
    expect(screen.getByRole('alert').className).toContain('rounded-[var(--radius,0.75rem)]');
  });
  it('an action button runs its handler and closes the toast', () => {
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Fire onUndo={undo} />
      </ToastProvider>
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// a11y re-audit (stop4 probe, rule (d)): the toast's close button measured 16x16 and was named
// "Dismiss notification" in English on Arabic pages. It is a 44px target named by the provider.
describe('Toast close', () => {
  it('is a 44px box, named in the page language', () => {
    render(
      <ToastProvider dismissLabel="إغلاق الإشعار">
        <Fire />
      </ToastProvider>
    );
    const close = screen.getByRole('button', { name: 'إغلاق الإشعار' });
    expect(close.className).toMatch(/\bh-11\b/);
    expect(close.className).toMatch(/\bw-11\b/);
  });
});
