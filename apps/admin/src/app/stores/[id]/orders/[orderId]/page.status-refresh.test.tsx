// @vitest-environment jsdom
/**
 * Marking a COD order delivered makes it paid on the server. The detail page used to patch only `status`
 * locally, so the payment card kept saying "unpaid" until a reload (Amelia QA 2026-11-23). Every status
 * write must re-read the order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1', orderId: 'o1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: (p: { children: React.ReactNode }) => <a>{p.children}</a>,
}));
vi.mock('@ebda/ui', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../../components/OrderStatusBadge', () => ({ OrderStatusBadge: () => null }));
vi.mock('../../../../../components/ConfirmActionModal', () => ({ ConfirmActionModal: () => null }));
vi.mock('../../../../../components/ManualRefundModal', () => ({ ManualRefundModal: () => null }));
vi.mock('../../../../../components/order-timeline/OrderLifecycleTimeline', () => ({
  OrderLifecycleTimeline: () => null,
}));
vi.mock('../../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: 'owner' } }) }));
vi.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => false, isLoading: false }),
}));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/ArrowStart', () => ({ ArrowStart: () => null }));
vi.mock('./_components/DeliveryCard', () => ({ DeliveryCard: () => null }));
vi.mock('./_components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('./_components/ItemsCard', () => ({ ItemsCard: () => null }));
vi.mock('./_components/PlatformCard', () => ({ PlatformCard: () => null }));
vi.mock('./_components/CustomerCard', () => ({ CustomerCard: () => null }));
vi.mock('./_components/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('./_components/ShipmentCard', () => ({ ShipmentCard: () => null }));
vi.mock('./_components/OrderInstapayPanel', () => ({ OrderInstapayPanel: () => null }));
vi.mock('./_components/OrderDocumentsCard', () => ({ OrderDocumentsCard: () => null }));
vi.mock('./_components/OrderCodRiskCard', () => ({ OrderCodRiskCard: () => null }));
vi.mock('./_components/OrderEtaCard', () => ({ OrderEtaCard: () => null }));
vi.mock('./_components/PaymentCard', () => ({
  PaymentCard: ({ order }: { order: { paymentStatus: string } }) => (
    <div data-testid="pay">{order.paymentStatus}</div>
  ),
}));
vi.mock('./_components/ActionFooter', () => ({
  ActionFooter: ({ onStatusChange }: { onStatusChange: (s: string) => void }) => (
    <button onClick={() => onStatusChange('delivered')}>deliver</button>
  ),
}));

const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock('../../../../../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPut: (...a: unknown[]) => apiPut(...a),
  apiPost: vi.fn(),
}));

import OrderDetailPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const order = (status: string, paymentStatus: string) => ({
  order: { id: 'o1', orderNumber: 'N1', status, paymentStatus, createdAt: '2026-11-23T00:00:00Z' },
});

describe('order detail: status write re-syncs the order', () => {
  it('shows paid after a COD order is marked delivered, without a reload', async () => {
    apiGet
      .mockResolvedValueOnce({ data: order('shipped', 'pending'), error: null })
      .mockResolvedValue({ data: order('delivered', 'paid'), error: null });
    apiPut.mockResolvedValue({ data: {}, error: null });
    render(<OrderDetailPage />);
    expect((await screen.findByTestId('pay')).textContent).toBe('pending');
    fireEvent.click(screen.getByText('deliver'));
    await waitFor(() => expect(screen.getByTestId('pay').textContent).toBe('paid'));
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
