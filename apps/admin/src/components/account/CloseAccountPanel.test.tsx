// @vitest-environment jsdom
/**
 * Row 33 (S2c): the merchant closure button. It must stay disabled until the confirmation word is typed, call
 * POST /auth/me/close-account exactly once, end the session on success, and show the server's refusal (flag off = 503
 * ERASURE_NOT_ENABLED) without ending the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  result: { data: { status: 'erased' }, error: null } as {
    data: unknown;
    error: { message: string; code: string; status: number } | null;
  },
}));

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: { word?: string }) =>
      key === 'confirmWord' ? 'CLOSE' : `${key}${v?.word ?? ''}`,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../lib/api', () => ({
  apiPost: async (path: string) => {
    h.calls.push(path);
    return h.result;
  },
}));

import { ToastProvider } from '@ebda/ui';
import { CloseAccountPanel } from './CloseAccountPanel';

beforeEach(() => {
  h.calls = [];
  h.result = { data: { status: 'erased' }, error: null };
});
afterEach(cleanup);

const mount = (onClosed: () => void) =>
  render(
    <ToastProvider>
      <CloseAccountPanel onClosed={onClosed} />
    </ToastProvider>
  );

describe('CloseAccountPanel', () => {
  it('is disabled until the confirmation word is typed, then closes once and ends the session', async () => {
    const onClosed = vi.fn();
    mount(onClosed);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'close' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'CLOSE' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(h.calls).toEqual(['/auth/me/close-account']);
  });

  it('shows the server refusal and keeps the session when erasure is not enabled', async () => {
    h.result = {
      data: null,
      error: { message: 'erasure is not enabled yet', code: 'ERASURE_NOT_ENABLED', status: 503 },
    };
    const onClosed = vi.fn();
    mount(onClosed);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'CLOSE' } });
    fireEvent.click(screen.getByRole('button'));
    expect((await screen.findByRole('alert')).textContent).toBe('erasure is not enabled yet');
    expect(onClosed).not.toHaveBeenCalled();
  });
});
