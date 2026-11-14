// @vitest-environment jsdom
/**
 * INSTAPAY-AUTO-1 S9: the super-admin auto-confirm screen. Labels come from the REAL message files, so a reason code without an Arabic or
 * English label (the raw-key-in-production class) fails here, and the loop is over the foundation's enum: a new code must be labelled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { REASON_ORDER } from '@ebda/shared';
import en from '../../i18n/messages/en.json';
import ar from '../../i18n/messages/ar.json';

const { apiPost, apiPut, locale } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  locale: { v: 'en' },
}));
vi.mock('next-intl', () => ({ useLocale: () => locale.v }));
vi.mock('../../lib/api', () => ({ apiPost, apiPut, apiGet: vi.fn() }));
vi.mock('../mobile/DataTable', () => ({
  DataTable: ({
    columns,
    rows,
    rowKey,
  }: {
    columns: Array<{ header: string; cell: (r: never) => React.ReactNode }>;
    rows: never[];
    rowKey: (r: never) => string;
  }) => (
    <table>
      <tbody>
        {rows.map(r => (
          <tr key={rowKey(r)}>
            {columns.map(c => (
              <td key={c.header}>{c.cell(r)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Input: ({
    label,
    error,
    ...p
  }: { label?: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={p.id}>{label}</label>
      <input {...p} />
      {error && <p role="alert">{error}</p>}
    </div>
  ),
  Modal: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}));
vi.mock('@/components/ui/Button', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));
vi.mock('../../i18n/useT', () => ({
  useT: (ns: string) => (key: string, vars?: Record<string, string>) => {
    const dict = (locale.v === 'ar' ? ar : en) as unknown as Record<string, unknown>;
    const leaf = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);
    if (typeof leaf !== 'string') return `MISSING:${ns}.${key}`;
    return leaf.replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? '');
  },
}));

import { AutoConfirmList, type AutoConfirmRow } from './AutoConfirmList';
import { AutoConfirmSwitches } from './AutoConfirmSwitches';

afterEach(() => {
  cleanup();
  apiPost.mockReset();
  apiPut.mockReset();
  locale.v = 'en';
});

const row = (over: Partial<AutoConfirmRow> = {}): AutoConfirmRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  storeId: 'store-1',
  state: 'needs_human',
  reasons: [],
  amountMinor: 120050,
  expectedAmountMinor: 120050,
  createdAt: '2026-11-14T10:00:00.000Z',
  ...over,
});

describe('S9 reasons', () => {
  for (const lang of ['en', 'ar'] as const)
    it(`every ReasonCode has a ${lang} label (enum-driven)`, () => {
      locale.v = lang;
      render(
        <AutoConfirmList rows={[row({ reasons: [...REASON_ORDER] })]} onChanged={() => undefined} />
      );
      expect(document.body.textContent).not.toContain('MISSING:');
      const dict = (lang === 'ar' ? ar : en) as unknown as {
        billingEvents: { autoConfirm: { reasons: Record<string, string> } };
      };
      for (const code of REASON_ORDER)
        expect(dict.billingEvents.autoConfirm.reasons[code]).toBeTruthy();
    });
  it('every lifecycle state has a label', () => {
    for (const state of [
      'pending_decision',
      'auto_confirmed',
      'needs_human',
      'reverted',
      'failed',
    ] as const) {
      render(<AutoConfirmList rows={[row({ state })]} onChanged={() => undefined} />);
    }
    expect(document.body.textContent).not.toContain('MISSING:');
  });
});

describe('S9 not received', () => {
  it('only an auto-confirmed row has the button; the dialog needs a reason and posts it', async () => {
    const changed = vi.fn();
    apiPost.mockResolvedValue({ data: { result: 'reverted' } });
    render(
      <AutoConfirmList
        rows={[row({ id: 'a', state: 'needs_human' }), row({ id: 'b', state: 'auto_confirmed' })]}
        onChanged={changed}
      />
    );
    const buttons = screen.getAllByRole('button', { name: 'Not received' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    const submit = screen.getByRole('button', { name: 'Mark not received' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // no reason yet
    fireEvent.change(screen.getByLabelText('Why (3+ characters)'), {
      target: { value: 'bank shows nothing' },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/billing/auto-confirmations/b/revert', {
        reason: 'bank shows nothing',
      })
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
});

describe('S9 switches', () => {
  it('shows the current mode from the API and refuses a change without a reason', async () => {
    render(<AutoConfirmSwitches mode="shadow" disabledStores={[]} onChanged={() => undefined} />);
    expect(screen.getByTestId('auto-mode-current').textContent).toContain('Shadow');
    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    expect(apiPut).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Write why');
  });
  it('a global change with a reason is PUT once', async () => {
    const changed = vi.fn();
    apiPut.mockResolvedValue({ data: { mode: 'off' } });
    render(<AutoConfirmSwitches mode="live" disabledStores={[]} onChanged={changed} />);
    fireEvent.change(screen.getAllByLabelText('Why (5+ characters)')[0], {
      target: { value: 'kill switch drill' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/admin/billing/auto-confirm/mode', {
        mode: 'off',
        reason: 'kill switch drill',
      })
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
  it('a per-store switch needs a reason and targets that store', async () => {
    apiPut.mockResolvedValue({ data: { enabled: false } });
    render(<AutoConfirmSwitches mode="live" disabledStores={[]} onChanged={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Store id'), { target: { value: 'store-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    expect(apiPut).not.toHaveBeenCalled();
    const [globalReason, storeReason] = screen.getAllByLabelText(/Why \(5\+ characters\)/);
    void globalReason;
    fireEvent.change(storeReason, { target: { value: 'money dispute here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/admin/stores/store-9/auto-confirm', {
        enabled: false,
        reason: 'money dispute here',
      })
    );
  });
});
