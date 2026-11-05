// @vitest-environment jsdom
/**
 * Notifications page order (UX:NT-1): the events x channels table comes first, the channel credentials sit in a
 * collapsed group below it, and the broadcast composer is tucked away as a campaign-style action.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  EventConfigTable: () => <div data-testid="events" />,
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

describe('notifications page order', () => {
  it('puts the event table before the channel credentials and the broadcast composer', async () => {
    apiGet.mockResolvedValue({ data: null, error: null });
    render(<NotificationsPage />);
    const events = await screen.findByTestId('events');
    const sms = screen.getByTestId('sms');
    const broadcast = screen.getByTestId('broadcast');
    const follows = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(events, sms)).toBe(true);
    expect(follows(sms, broadcast)).toBe(true);
    // credentials and composer live inside collapsible groups
    expect(sms.closest('details')).not.toBeNull();
    expect(broadcast.closest('details')).not.toBeNull();
    expect(events.closest('details')).toBeNull();
  });
});
