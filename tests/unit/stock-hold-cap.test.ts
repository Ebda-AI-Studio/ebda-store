/**
 * Stock-hold abuse fix: `assertStockHoldCapNotExceeded` is the shared guard
 * `OrderService.create` calls before reserving stock for a NEW order on a
 * payment method that never captures synchronously (COD, InstaPay). Without
 * it, a guest checkout could accumulate an unbounded number of open
 * pending/awaiting-confirmation unpaid orders against the same phone, email
 * or IP — pinning stock with zero payment and zero verification (COD is
 * deliberately excluded from the 2-day auto-cancel sweep, ruling MONEYB-7;
 * InstaPay sits open for its own expiry window).
 *
 * Pure-logic test against a stub `tx.$queryRaw` — no DB — mirroring the
 * `decideAutoCancelAction` extraction pattern in `order-auto-cancel-unpaid.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assertStockHoldCapNotExceeded,
  openUnpaidHoldCap,
  HOLD_CAPPED_PAYMENT_METHODS,
} from '@api/lib/stock-hold-cap';
import { AppError } from '@api/middleware/error-handler';

describe('stock-hold-cap', () => {
  afterEach(() => {
    delete process.env.OPEN_UNPAID_HOLD_CAP;
  });

  describe('openUnpaidHoldCap', () => {
    it('defaults to 2', () => {
      expect(openUnpaidHoldCap()).toBe(2);
    });

    it('reads a configured positive integer', () => {
      process.env.OPEN_UNPAID_HOLD_CAP = '5';
      expect(openUnpaidHoldCap()).toBe(5);
    });

    it('falls back to the default on garbage/zero/negative', () => {
      for (const v of ['0', '-1', 'abc', '']) {
        process.env.OPEN_UNPAID_HOLD_CAP = v;
        expect(openUnpaidHoldCap()).toBe(2);
      }
    });
  });

  describe('HOLD_CAPPED_PAYMENT_METHODS', () => {
    it('covers exactly cod + instapay — real-time gateways capture synchronously', () => {
      expect(HOLD_CAPPED_PAYMENT_METHODS.has('cod')).toBe(true);
      expect(HOLD_CAPPED_PAYMENT_METHODS.has('instapay')).toBe(true);
      expect(HOLD_CAPPED_PAYMENT_METHODS.has('kashier')).toBe(false);
      expect(HOLD_CAPPED_PAYMENT_METHODS.has('paymob')).toBe(false);
      expect(HOLD_CAPPED_PAYMENT_METHODS.has('fawry')).toBe(false);
    });
  });

  describe('assertStockHoldCapNotExceeded', () => {
    function tx(phoneOrEmailCount: number, ipCount = 0) {
      return {
        $queryRaw: vi
          .fn()
          .mockResolvedValue([
            { phone_or_email_count: BigInt(phoneOrEmailCount), ip_count: BigInt(ipCount) },
          ]),
      };
    }

    it('never queries for a synchronously-captured method (kashier)', async () => {
      const t = tx(999);
      await assertStockHoldCapNotExceeded(t, 'store1', 'kashier', { phone: '+201000000000' });
      expect(t.$queryRaw).not.toHaveBeenCalled();
    });

    it('never queries for a synchronously-captured method (paymob)', async () => {
      const t = tx(999);
      await assertStockHoldCapNotExceeded(t, 'store1', 'paymob', { phone: '+201000000000' });
      expect(t.$queryRaw).not.toHaveBeenCalled();
    });

    it('skips the check entirely when no identity signal is present (no false block on an unidentifiable guest)', async () => {
      const t = tx(999);
      await assertStockHoldCapNotExceeded(t, 'store1', 'cod', {});
      expect(t.$queryRaw).not.toHaveBeenCalled();
    });

    it('allows a normal customer under the cap (1 existing open hold, cap 2)', async () => {
      const t = tx(1);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { phone: '+201000000000' })
      ).resolves.toBeUndefined();
    });

    it('rejects once the phone/email count reaches the cap (default 2)', async () => {
      const t = tx(2);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { phone: '+201000000000' })
      ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
    });

    it('rejects for instapay the same way', async () => {
      const t = tx(2);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'instapay', { email: 'a@b.com' })
      ).rejects.toBeInstanceOf(AppError);
    });

    it('respects a configured lower identity cap', async () => {
      process.env.OPEN_UNPAID_HOLD_CAP = '1';
      const t = tx(1);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { phone: '+201000000000' })
      ).rejects.toMatchObject({ statusCode: 429 });
    });

    it('does NOT reject on a shared IP alone until the much looser IP cap is reached (CGNAT tolerance)', async () => {
      // Identity cap is 2 (default); IP cap defaults to 4x = 8. 3 unrelated
      // shoppers sharing one carrier-NAT IP must not block each other.
      const t = tx(0, 3);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { ip: '1.2.3.4' })
      ).resolves.toBeUndefined();
    });

    it('still rejects once the looser IP-only cap is reached', async () => {
      const t = tx(0, 8);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { ip: '1.2.3.4' })
      ).rejects.toMatchObject({ statusCode: 429 });
    });

    it('respects a configured IP cap independently of the identity cap', async () => {
      process.env.OPEN_UNPAID_HOLD_IP_CAP = '2';
      const t = tx(0, 2);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { ip: '1.2.3.4' })
      ).rejects.toMatchObject({ statusCode: 429 });
      delete process.env.OPEN_UNPAID_HOLD_IP_CAP;
    });

    it('queries with the identity values as raw-SQL parameters', async () => {
      const t = tx(0);
      await assertStockHoldCapNotExceeded(t, 'store1', 'cod', {
        phone: '+201000000000',
        email: 'a@b.com',
        ip: '1.2.3.4',
      });
      expect(t.$queryRaw).toHaveBeenCalledTimes(1);
      const callArgs = t.$queryRaw.mock.calls[0];
      // Tagged-template call: [strings, ...values] — values are phone, email (x2 each,
      // once per FILTER null-guard + comparison), ip (x2), storeId.
      expect(callArgs.slice(1)).toEqual(
        expect.arrayContaining(['+201000000000', 'a@b.com', '1.2.3.4', 'store1'])
      );
    });
  });
});
