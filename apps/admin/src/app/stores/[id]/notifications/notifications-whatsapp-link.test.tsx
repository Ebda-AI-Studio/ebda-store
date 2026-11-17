// @vitest-environment jsdom
/** Ruling NT1-A-DEFAULT: the page reads the Ebda Chat link state; a failed read is `error`, never "not connected". */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1' }),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPut: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: 'store_admin' } }) }));
vi.mock('../../../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => true, isLoading: false }),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/EnableOrderAlertsButton', () => ({
  EnableOrderAlertsButton: () => null,
}));
vi.mock('./_components/EventConfigTable', () => ({
  EventConfigTable: ({ whatsapp }: { whatsapp: unknown }) => (
    <div data-testid="events" data-wa={JSON.stringify(whatsapp)} />
  ),
}));
vi.mock('./_components/SmsChannelCard', () => ({
  SmsChannelCard: () => <div data-testid="sms" />,
}));
vi.mock('./_components/PushChannelCard', () => ({
  PushChannelCard: () => <div data-testid="push" />,
}));
vi.mock('./_components/BroadcastComposerCard', () => ({
  BroadcastComposerCard: () => <div data-testid="broadcast" />,
}));
vi.mock('./_components/WebPushToggleCard', () => ({
  WebPushToggleCard: () => <div data-testid="webpush" />,
}));
vi.mock('./_components/NotificationsLog', () => ({ NotificationsLog: () => null }));

import NotificationsPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const run = async (impl: (url: string) => unknown) => {
  apiGet.mockImplementation((url: string) => Promise.resolve(impl(url)));
  render(<NotificationsPage />);
  const el = await screen.findByTestId('events');
  return el;
};
const ok = { data: null, error: null };

describe('notifications page, WhatsApp link state', () => {
  it('linked store passes ready/active', async () => {
    const el = await run(u =>
      u.endsWith('/whatsapp-link') ? { data: { active: true }, error: null } : ok
    );
    expect(JSON.parse(el.getAttribute('data-wa') as string)).toEqual({
      kind: 'ready',
      active: true,
    });
  });
  it('unlinked store passes ready/inactive', async () => {
    const el = await run(u =>
      u.endsWith('/whatsapp-link') ? { data: { active: false }, error: null } : ok
    );
    expect(JSON.parse(el.getAttribute('data-wa') as string)).toEqual({
      kind: 'ready',
      active: false,
    });
  });
  it('API error passes error, not inactive', async () => {
    const el = await run(u =>
      u.endsWith('/whatsapp-link') ? { data: null, error: { message: 'boom' } } : ok
    );
    await waitFor(() =>
      expect(JSON.parse(el.getAttribute('data-wa') as string)).toEqual({ kind: 'error' })
    );
  });
  it('a thrown fetch passes error', async () => {
    apiGet.mockImplementation((u: string) =>
      u.endsWith('/whatsapp-link') ? Promise.reject(new Error('net')) : Promise.resolve(ok)
    );
    render(<NotificationsPage />);
    const el = await screen.findByTestId('events');
    expect(JSON.parse(el.getAttribute('data-wa') as string)).toEqual({ kind: 'error' });
  });
});
