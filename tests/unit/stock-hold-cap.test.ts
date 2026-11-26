/**
 * Stock-hold abuse fix: `assertStockHoldCapNotExceeded` is the shared guard
 * `OrderService.create` calls inside the transaction before reserving stock for a NEW order on a
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
  resolveStoreHoldCaps,
  openUnpaidHoldIpCap,
  openUnpaidHoldIpWindowHours,
  openUnpaidHoldCap,
  openUnpaidGatewayHoldCap,
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
    it('tight-cap set is exactly cod + instapay; every other label uses the looser gateway cap', () => {
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
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi
          .fn()
          .mockResolvedValue([
            { phone_or_email_count: BigInt(phoneOrEmailCount), ip_count: BigInt(ipCount) },
          ]),
      };
    }

    it('counts a gateway-labelled order too, against the looser cap of 5 (S4-1)', async () => {
      for (const method of ['kashier', 'paymob', 'card-anything']) {
        const under = tx(4);
        await expect(
          assertStockHoldCapNotExceeded(under, 'store1', method, { phone: '+201000000000' })
        ).resolves.toBeUndefined();
        expect(under.$queryRaw).toHaveBeenCalledTimes(1);
        const over = tx(5);
        await expect(
          assertStockHoldCapNotExceeded(over, 'store1', method, { phone: '+201000000000' })
        ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
      }
    });

    it('counts failed-payment orders as open holds in BOTH the identity and the IP query (Ruling INV-AUDIT-2)', async () => {
      const t = tx(0);
      await assertStockHoldCapNotExceeded(t, 'store1', 'cod', {
        phone: '+201000000000',
        ip: '1.2.3.4',
      });
      const sql = (t.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');
      const filters = sql.match(/"payment_status" IN \('unpaid', 'failed'\)/g) ?? [];
      expect(filters).toHaveLength(2);
      expect(sql).not.toMatch(/"payment_status" = 'unpaid'/);
    });

    it('gateway IP cap is 4x the gateway identity cap (20) and configurable', async () => {
      await expect(
        assertStockHoldCapNotExceeded(tx(0, 19), 'store1', 'paymob', { ip: '1.2.3.4' })
      ).resolves.toBeUndefined();
      await expect(
        assertStockHoldCapNotExceeded(tx(0, 20), 'store1', 'paymob', { ip: '1.2.3.4' })
      ).rejects.toMatchObject({ statusCode: 429 });
      process.env.OPEN_UNPAID_GATEWAY_HOLD_CAP = '2';
      expect(openUnpaidGatewayHoldCap()).toBe(2);
      await expect(
        assertStockHoldCapNotExceeded(tx(2), 'store1', 'paymob', { phone: '+201000000000' })
      ).rejects.toMatchObject({ statusCode: 429 });
      delete process.env.OPEN_UNPAID_GATEWAY_HOLD_CAP;
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
      // Identity cap is 2 (default); the COD IP cap is 40 per 24 h (QA-HOLDS-1). Thirty-nine unrelated
      // shoppers sharing one carrier-NAT IP must not block each other (the QA run was refused at 8).
      const t = tx(0, 39);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { ip: '1.2.3.4' })
      ).resolves.toBeUndefined();
    });

    it('still rejects once the looser IP-only cap is reached', async () => {
      const t = tx(0, 40);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { ip: '1.2.3.4' })
      ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
    });

    it('respects a configured IP cap independently of the identity cap', async () => {
      process.env.OPEN_UNPAID_HOLD_IP_CAP = '2';
      const t = tx(0, 2);
      await expect(
        assertStockHoldCapNotExceeded(t, 'store1', 'cod', { ip: '1.2.3.4' })
      ).rejects.toMatchObject({ statusCode: 429 });
      delete process.env.OPEN_UNPAID_HOLD_IP_CAP;
    });

    it('locks canonical tenant identity keys before counting, in stable order', async () => {
      const t = tx(0);
      await assertStockHoldCapNotExceeded(t, 'store1', 'cod', {
        phone: '+201000000000',
        email: ' Buyer@Example.com ',
        ip: '203.0.113.8',
      });
      const keys = t.$executeRaw.mock.calls.map(call => call[1]);
      expect(keys).toHaveLength(3);
      expect(keys).toEqual([...keys].sort());
      expect(keys.some(key => String(key).includes('buyer@example.com'))).toBe(true);
      expect(t.$executeRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
        t.$queryRaw.mock.invocationCallOrder[0]
      );
      expect(t.$queryRaw.mock.calls[0].slice(1)).toContain('buyer@example.com');
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

  describe('QA-HOLDS-1: COD behind a shared IP', () => {
    afterEach(() => {
      delete process.env.OPEN_UNPAID_HOLD_IP_CAP;
      delete process.env.OPEN_UNPAID_HOLD_IP_WINDOW_HOURS;
    });
    const tx = (phoneOrEmail: number, ip = 0) => ({
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ phone_or_email_count: BigInt(phoneOrEmail), ip_count: BigInt(ip) }]),
    });

    it('defaults: COD IP ceiling 40, counted over the last 24 hours', () => {
      expect(openUnpaidHoldIpCap()).toBe(40);
      expect(openUnpaidHoldIpWindowHours()).toBe(24);
      expect(resolveStoreHoldCaps(null)).toEqual({
        manual: 2,
        gateway: 5,
        ip: 40,
        ipWindowHours: 24,
      });
    });

    it('the eight-orders-one-IP case from the QA run is no longer refused (distinct phones)', async () => {
      await expect(
        assertStockHoldCapNotExceeded(tx(1, 8), 'store1', 'cod', {
          phone: '+201000000009',
          ip: '41.1.1.1',
        })
      ).resolves.toBeUndefined();
    });

    it('still refuses ONE phone that already holds the identity cap, behind any IP (abuse protection kept)', async () => {
      await expect(
        assertStockHoldCapNotExceeded(tx(2, 0), 'store1', 'cod', {
          phone: '+201000000009',
          ip: '41.1.1.1',
        })
      ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_OPEN_HOLDS' });
    });

    it('a refusal on the IP ceiling says so in Arabic and differs from the identity refusal', async () => {
      const ipHit = await assertStockHoldCapNotExceeded(tx(0, 40), 'store1', 'cod', {
        ip: '41.1.1.1',
      }).catch(e => e);
      const idHit = await assertStockHoldCapNotExceeded(tx(2, 0), 'store1', 'cod', {
        phone: '+201000000009',
      }).catch(e => e);
      expect(ipHit.details.messageAr).toMatch(/الشبكة/);
      expect(idHit.details.messageAr).toMatch(/طلبات/);
      expect(ipHit.message).not.toBe(idHit.message);
    });

    it('the IP count is bounded by the window: the window hours go to the SQL as a parameter', async () => {
      const t = tx(0, 0);
      await assertStockHoldCapNotExceeded(
        t,
        'store1',
        'cod',
        { ip: '41.1.1.1' },
        { manual: 2, gateway: 5, ip: 40, ipWindowHours: 6 }
      );
      expect(t.$queryRaw.mock.calls[0].slice(1)).toContain(6);
      expect(String(t.$queryRaw.mock.calls[0][0])).toContain('created_at');
    });

    it('a per-store override applies, and an out-of-range one cannot switch the protection off', async () => {
      const caps = resolveStoreHoldCaps({
        stockHoldCaps: { manual: 3, ip: 100, ipWindowHours: 48 },
      });
      expect(caps).toMatchObject({ manual: 3, ip: 100, ipWindowHours: 48, gateway: 5 });
      await expect(
        assertStockHoldCapNotExceeded(
          tx(2, 99),
          'store1',
          'cod',
          { phone: '+2010', ip: '1.1.1.1' },
          caps
        )
      ).resolves.toBeUndefined();
      await expect(
        assertStockHoldCapNotExceeded(tx(0, 100), 'store1', 'cod', { ip: '1.1.1.1' }, caps)
      ).rejects.toMatchObject({ statusCode: 429 });
      const hostile = resolveStoreHoldCaps({
        stockHoldCaps: { manual: 0, gateway: 9999, ip: 1, ipWindowHours: 100000 },
      });
      expect(hostile).toEqual({ manual: 2, gateway: 5, ip: 40, ipWindowHours: 24 });
    });
  });
});
