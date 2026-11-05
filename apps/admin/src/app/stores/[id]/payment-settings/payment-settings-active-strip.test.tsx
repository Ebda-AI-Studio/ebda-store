// @vitest-environment jsdom
/** The top strip answers "what is on right now" and switches a method without opening any credential form. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
}));

import { ActiveMethodsStrip } from './_components/ActiveMethodsStrip';

afterEach(cleanup);

describe('ActiveMethodsStrip', () => {
  it('says when nothing is on, and turns COD on with one click', () => {
    const onToggle = vi.fn();
    render(
      <ActiveMethodsStrip
        rows={[{ id: 'cod', name: 'الدفع عند الاستلام', enabled: false, onToggle }]}
      />
    );
    expect(screen.getByText('none')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'الدفع عند الاستلام' }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('counts what is on and lets a running method be turned off', () => {
    const onToggle = vi.fn();
    render(
      <ActiveMethodsStrip rows={[{ id: 'paymob', name: 'Paymob', enabled: true, onToggle }]} />
    );
    expect(screen.getByText('count:{"count":1}')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Paymob' }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('will not switch a method on while a reason blocks it', () => {
    const onToggle = vi.fn();
    render(
      <ActiveMethodsStrip
        rows={[
          { id: 'x', name: 'X', enabled: false, blockedReason: 'جرّب الاتصال الأول', onToggle },
        ]}
      />
    );
    expect((screen.getByRole('switch', { name: 'X' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('جرّب الاتصال الأول')).toBeTruthy();
  });
});
