/**
 * #659 review B2: a money alert a DO operation raised and committed (a wallet give-back trimmed by the one refundable
 * balance) reaches the platform alert channel, store-scoped, one P1 per alert; a failing alert never throws into the
 * caller (the money state is already committed and the review event is on the payment timeline).
 */
import { describe, expect, it, vi } from 'vitest';

const sendAlert = vi.fn();
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (...a: unknown[]) => sendAlert(...a),
}));

const { sendMoneyAlerts } = await import('@api/lib/repo-factory');

describe('sendMoneyAlerts', () => {
  it('sends one store-scoped P1 per committed money alert', async () => {
    sendAlert.mockResolvedValue({ ok: true });
    await sendMoneyAlerts('store-1', 'paymentWebhook', [
      {
        kind: 'wallet_giveback_trimmed',
        orderId: 'o1',
        body: 'trimmed',
        context: { planned: 4000, credited: 0 },
      },
    ]);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      scope: 'store',
      store: { id: 'store-1' },
      source: 'money.paymentWebhook.wallet_giveback_trimmed',
      context: { storeId: 'store-1', orderId: 'o1', planned: 4000, credited: 0 },
    });
  });

  it('never throws when the alert channel fails', async () => {
    sendAlert.mockRejectedValue(new Error('telegram down'));
    await expect(
      sendMoneyAlerts('store-1', 'returnFinish', [{ kind: 'k', orderId: 'o1', body: 'b' }])
    ).resolves.toBeUndefined();
  });
});
