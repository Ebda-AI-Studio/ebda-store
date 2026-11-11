/**
 * Ruling T01-CANCEL-1 (audit S3-O10): the shopper cancels their OWN order, only while it is pending, unpaid and cash on
 * delivery. Everything else is a 409 and writes nothing; a repeat is an idempotent no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrderService } from '@api/services/order.service';
import { AppError } from '@api/middleware/error-handler';

const STORE = 'store-1';
const ORDER = 'order-1';
const ME = 'cust-1';

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER,
  customerId: ME,
  status: 'pending',
  paymentStatus: 'unpaid',
  payments: [{ provider: 'cod', status: 'cod_pending' }],
  ...over,
});

describe('OrderService.customerCancel', () => {
  let update: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    update = vi.spyOn(OrderService, 'updateStatus').mockResolvedValue({} as never);
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (o: unknown) => {
    vi.spyOn(OrderService, 'getById').mockResolvedValue(o as never);
    return OrderService.customerCancel(STORE, ORDER, ME);
  };

  it('cancels a pending unpaid COD order with the atomic unpaid + still-pending guards', async () => {
    await expect(run(order())).resolves.toEqual({ changed: true, status: 'cancelled' });
    expect(update).toHaveBeenCalledWith(
      STORE,
      ORDER,
      'cancelled',
      expect.objectContaining({ unpaidOnly: true, onlyFrom: ['pending'] })
    );
  });

  it("answers another customer's order exactly like a missing one", async () => {
    await expect(run(order({ customerId: 'someone-else' }))).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a paid order (the money needs a refund, not a cancel)', async () => {
    await expect(run(order({ paymentStatus: 'paid' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_ALREADY_PAID',
    });
    await expect(
      run(order({ payments: [{ provider: 'cod', status: 'completed' }] }))
    ).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an online / InstaPay order (a payment could still land)', async () => {
    await expect(
      run(order({ payments: [{ provider: 'instapay', status: 'pending' }] }))
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_NOT_CANCELLABLE' });
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'processing', 'shipped', 'delivered'])(
    'refuses once the merchant moved it to %s',
    async status => {
      await expect(run(order({ status }))).rejects.toMatchObject({
        code: 'ORDER_NOT_CANCELLABLE',
      });
      expect(update).not.toHaveBeenCalled();
    }
  );

  it('is idempotent: an already-cancelled order is a no-op, not a second cancel', async () => {
    await expect(run(order({ status: 'cancelled' }))).resolves.toEqual({
      changed: false,
      status: 'cancelled',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('maps the merchant winning the race (ORDER_STATUS_MOVED) to a 409 that changed nothing', async () => {
    update.mockRejectedValueOnce(new AppError(409, 'ORDER_STATUS_MOVED', 'moved'));
    await expect(run(order())).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_NOT_CANCELLABLE',
    });
  });

  it('lets a payment landing first (ORDER_ALREADY_PAID from the guarded cancel) through as itself', async () => {
    update.mockRejectedValueOnce(new AppError(409, 'ORDER_ALREADY_PAID', 'paid'));
    await expect(run(order())).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' });
  });
});
