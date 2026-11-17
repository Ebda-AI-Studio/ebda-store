// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import en from '@/i18n/messages/en.json';

const lookup = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o) as string;
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (k: string, v?: Record<string, string>) => {
    const s = lookup(en, `${ns}.${k}`) ?? `${ns}.${k}`;
    return v ? s.replace(/\{(\w+)\}/g, (_m, n) => v[n]) : s;
  },
}));
vi.mock('@ebda/ui', () => ({
  Select: ({
    label,
    options,
    ...p
  }: {
    label: string;
    options: { value: string; label: string }[];
  } & React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <label>
      {label}
      <select {...p}>
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  ),
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
  cn: (...a: string[]) => a.filter(Boolean).join(' '),
}));
vi.mock('@/components/ui/Button', () => ({
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
}));
let role = 'super_admin';
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role } }) }));
vi.mock('../../../../lib/format', () => ({ formatDateTime: (d: string) => `T(${d})` }));
const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock('../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPut: (...a: unknown[]) => apiPut(...a),
}));

import { AssistantModeCard } from './AssistantModeCard';

const URL = '/api/v1/admin/assistant/stores/s1/mode';
const state = (mode: string, lastChange: unknown = null) => ({
  data: { mode, lastChange },
  error: null,
});

beforeEach(() => {
  cleanup();
  role = 'super_admin';
  apiGet.mockReset();
  apiPut.mockReset();
});

describe('AssistantModeCard', () => {
  it('renders the current mode, its meaning and the audit line', async () => {
    apiGet.mockResolvedValue(state('suggest', { by: 'Ada Root', at: '2026-11-14T10:00:00Z' }));
    render(<AssistantModeCard storeId="s1" />);
    await waitFor(() =>
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('suggest')
    );
    expect(apiGet).toHaveBeenCalledWith(URL);
    expect(screen.getByTestId('assistant-mode-meaning').textContent).toContain('preview');
    expect(screen.getByTestId('assistant-mode-trail').textContent).toBe(
      'Last changed by Ada Root at T(2026-11-14T10:00:00Z)'
    );
  });

  it('saving "off" PUTs straight away with no confirm step', async () => {
    apiGet.mockResolvedValue(state('answer-only'));
    apiPut.mockResolvedValue({ data: { mode: 'off' }, error: null });
    render(<AssistantModeCard storeId="s1" />);
    await waitFor(() => screen.getByRole('combobox'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'off' } });
    fireEvent.click(screen.getByText('Save mode'));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith(URL, { mode: 'off' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('any mode above off needs confirmation before the PUT', async () => {
    apiGet.mockResolvedValue(state('off'));
    apiPut.mockResolvedValue({ data: { mode: 'act' }, error: null });
    render(<AssistantModeCard storeId="s1" />);
    await waitFor(() => screen.getByRole('combobox'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'act' } });
    fireEvent.click(screen.getByText('Save mode'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(apiPut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    expect(apiPut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save mode'));
    fireEvent.click(screen.getByText('Yes, change the mode'));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith(URL, { mode: 'act' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  it('a non-super-admin never sees the control and nothing is fetched', () => {
    role = 'store_admin';
    const { container } = render(<AssistantModeCard storeId="s1" />);
    expect(container.innerHTML).toBe('');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('shows an error state when the load fails, and when the save fails', async () => {
    apiGet.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    render(<AssistantModeCard storeId="s1" />);
    await waitFor(() => screen.getByText('Could not load the assistant mode.'));
    apiGet.mockResolvedValue(state('off'));
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => screen.getByRole('combobox'));
    apiPut.mockResolvedValue({ data: null, error: { message: 'MFA required' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'suggest' } });
    fireEvent.click(screen.getByText('Save mode'));
    fireEvent.click(screen.getByText('Yes, change the mode'));
    await waitFor(() => expect(screen.getAllByRole('alert')[0]!.textContent).toBe('MFA required'));
  });
});
