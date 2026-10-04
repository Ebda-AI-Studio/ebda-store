/**
 * SHARED CONTRACT SUITE for payment provider adapters (v2, SP6a).
 *
 * Any adapter (the in-memory stub, COD, InstaPay now; Paymob / Kashier / Fawry in
 * 6b) calls `runPaymentProviderContract(label, makeTarget)` from its own test file
 * and gets the same assertions, so "works with the checkout" means the same thing
 * for every provider:
 *
 *   - amount fidelity to the piastre (and non-integer / zero / negative / non-EGP refused)
 *   - createPayment idempotent on its key (one provider-side payment)
 *   - webhook: good signature -> typed event; bad / missing / tampered body refused; a
 *     replay yields the identical event id (the inbox dedupes on it, so a replay is a no-op)
 *   - partial refunds: their sum never exceeds what was captured; refund idempotent
 *   - status mapping to PaymentStatus
 *   - outage: a timeout is a typed PROVIDER_TIMEOUT, creates nothing, and a retry with the
 *     same key yields exactly one payment; a rejection is not an outage
 *
 * Sections run against the adapter's declared `capabilities` (a COD / InstaPay adapter has
 * no webhook, refund or status API and must REFUSE them, which is asserted, not skipped).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  PaymentProviderError,
  type CreatePaymentV2Request,
  type PaymentProviderV2,
  type PaymentStatus,
  type ProviderCredentials,
  type WebhookHeaders,
} from '@api/services/payment-providers/types';

export interface ContractControl {
  /** The customer pays at the provider. */
  capture(providerRef: string): Promise<void> | void;
  /** A provider-signed payment webhook for the payment's current (or overridden) state. */
  paymentWebhook(
    providerRef: string,
    opts?: {
      state?: 'pending' | 'paid' | 'failed' | 'expired';
      amountMinor?: number;
      eventId?: string;
    }
  ): { rawBody: string; headers: WebhookHeaders };
  /** The next provider call misbehaves. */
  injectNextCall(fault: 'timeout' | 'unavailable' | 'rejected'): void;
  /** How many payments the provider side holds (the "no state change" probe). */
  providerPaymentCount(): number;
}

export interface ContractTarget {
  provider: PaymentProviderV2;
  creds: ProviderCredentials;
  /** Absent for adapters with no network (COD, InstaPay). */
  control?: ContractControl;
}

let seq = 0;
export function baseRequest(
  overrides: Partial<CreatePaymentV2Request> = {}
): CreatePaymentV2Request {
  const n = ++seq;
  return {
    orderId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    orderNumber: `ORD-${1000 + n}`,
    amountMinor: 12_345,
    currency: 'EGP',
    customer: { name: 'Mona Adel', email: 'mona@example.com', phone: '+201012345678' },
    returnUrls: { success: 'https://shop.test/ok', failure: 'https://shop.test/fail' },
    idempotencyKey: `idem-${n}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

async function rejection(p: Promise<unknown>): Promise<PaymentProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PaymentProviderError);
    return e as PaymentProviderError;
  }
  throw new Error('expected a PaymentProviderError, the call resolved');
}

function thrownSync(fn: () => unknown): PaymentProviderError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PaymentProviderError);
    return e as PaymentProviderError;
  }
  throw new Error('expected a PaymentProviderError, the call returned');
}

export function runPaymentProviderContract(label: string, make: () => ContractTarget): void {
  describe(`payment provider contract: ${label}`, () => {
    // Capabilities are static per adapter, so they decide WHICH tests are registered; every
    // test then runs against a FRESH target from `make()` (fresh gateway, no shared state).
    const probe = make();
    const caps = probe.provider.capabilities;
    const hasControl = Boolean(probe.control);
    let t: ContractTarget;
    beforeEach(() => {
      t = make();
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('capabilities', () => {
      it('declares EGP and at least one instruction kind it can return', () => {
        expect(t.provider.capabilities.currencies).toContain('EGP');
        expect(t.provider.capabilities.instructions.length).toBeGreaterThan(0);
        expect(t.provider.capabilities.methods.length).toBeGreaterThan(0);
      });

      it('a partial-refund adapter is also a refund adapter', () => {
        const c = t.provider.capabilities;
        if (c.partialRefunds) expect(c.refunds).toBe(true);
      });
    });

    describe('amount fidelity to the piastre', () => {
      // 29 / 99 / 1999 are the amounts where `x / 100 * 100` drifts in floating point.
      const amounts = [1, 29, 57, 99, 100, 101, 1_999, 12_345, 99_999, 1_000_001, 12_345_678];
      for (const amountMinor of amounts) {
        it(`${amountMinor} piastres in -> ${amountMinor} piastres recorded`, async () => {
          const res = await t.provider.createPayment(baseRequest({ amountMinor }), t.creds);
          expect(res.amountMinor).toBe(amountMinor);
          expect(res.currency).toBe('EGP');
          if (res.instruction.kind === 'manual-instructions') {
            expect(res.instruction.amountMinor).toBe(amountMinor);
          }
          if (t.provider.capabilities.remoteStatus) {
            const st = await t.provider.getStatus(res.providerRef, t.creds);
            expect(st.amountMinor).toBe(amountMinor);
          }
        });
      }

      it('refuses a fractional, zero, negative, NaN or unsafe amount and creates nothing', async () => {
        const before = t.control?.providerPaymentCount() ?? 0;
        for (const bad of [12.5, 0, -100, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
          const err = await rejection(
            t.provider.createPayment(baseRequest({ amountMinor: bad }), t.creds)
          );
          expect(err.code).toBe('AMOUNT_INVALID');
        }
        expect(t.control?.providerPaymentCount() ?? 0).toBe(before);
      });

      it('refuses any currency but EGP', async () => {
        const err = await rejection(
          t.provider.createPayment(
            baseRequest({ currency: 'KWD' as unknown as 'EGP', amountMinor: 1000 }),
            t.creds
          )
        );
        expect(err.code).toBe('CURRENCY_UNSUPPORTED');
      });
    });

    describe('createPayment', () => {
      it('returns an instruction of a declared kind, with a provider reference', async () => {
        const res = await t.provider.createPayment(baseRequest(), t.creds);
        expect(t.provider.capabilities.instructions).toContain(res.instruction.kind);
        expect(res.providerRef.length).toBeGreaterThan(0);
        expect(['pending', 'processing', 'cod_pending']).toContain(res.status);
      });

      it('is idempotent on its key: same key, same payment, ONE provider-side payment', async () => {
        const req = baseRequest();
        const a = await t.provider.createPayment(req, t.creds);
        const b = await t.provider.createPayment({ ...req }, t.creds);
        expect(b.providerRef).toBe(a.providerRef);
        expect(b.amountMinor).toBe(a.amountMinor);
        if (t.control) expect(t.control.providerPaymentCount()).toBe(1);
      });

      it('a different key is a different payment', async () => {
        const a = await t.provider.createPayment(baseRequest(), t.creds);
        const b = await t.provider.createPayment(baseRequest(), t.creds);
        expect(b.providerRef).not.toBe(a.providerRef);
        if (t.control) expect(t.control.providerPaymentCount()).toBe(2);
      });

      if (!caps.remoteStatus) {
        it('a method with no provider makes no network call', async () => {
          const fetchSpy = vi.spyOn(globalThis, 'fetch');
          await t.provider.createPayment(baseRequest(), t.creds);
          expect(fetchSpy).not.toHaveBeenCalled();
        });
      }
    });

    describe('webhook', () => {
      if (caps.webhooks) {
        const ctl = () => {
          if (!t.control) throw new Error('a webhook adapter must supply test controls');
          return t.control;
        };

        it('a good signature yields a typed payment event with the exact amount', async () => {
          const created = await t.provider.createPayment(
            baseRequest({ amountMinor: 29_999 }),
            t.creds
          );
          await ctl().capture(created.providerRef);
          const { rawBody, headers } = ctl().paymentWebhook(created.providerRef);
          const ev = t.provider.verifyWebhook(rawBody, headers, t.creds);
          expect(ev.kind).toBe('payment');
          if (ev.kind !== 'payment') return;
          expect(ev.providerRef).toBe(created.providerRef);
          expect(ev.status).toBe('completed' satisfies PaymentStatus);
          expect(ev.amountMinor).toBe(29_999);
          expect(ev.currency).toBe('EGP');
          expect(ev.eventId.length).toBeGreaterThan(0);
        });

        it('accepts the raw body as a Buffer too', async () => {
          const created = await t.provider.createPayment(baseRequest(), t.creds);
          const { rawBody, headers } = ctl().paymentWebhook(created.providerRef);
          expect(() =>
            t.provider.verifyWebhook(Buffer.from(rawBody, 'utf8'), headers, t.creds)
          ).not.toThrow();
        });

        it('refuses a bad signature', async () => {
          const created = await t.provider.createPayment(baseRequest(), t.creds);
          const { rawBody } = ctl().paymentWebhook(created.providerRef);
          const err = thrownSync(() =>
            t.provider.verifyWebhook(rawBody, { 'x-stub-signature': 'deadbeef' }, t.creds)
          );
          expect(err.code).toBe('WEBHOOK_BAD_SIGNATURE');
        });

        it('refuses a missing signature', async () => {
          const created = await t.provider.createPayment(baseRequest(), t.creds);
          const { rawBody } = ctl().paymentWebhook(created.providerRef);
          expect(thrownSync(() => t.provider.verifyWebhook(rawBody, {}, t.creds)).code).toBe(
            'WEBHOOK_BAD_SIGNATURE'
          );
        });

        it('refuses a body signed with another merchant secret', async () => {
          const created = await t.provider.createPayment(baseRequest(), t.creds);
          const { rawBody, headers } = ctl().paymentWebhook(created.providerRef);
          const err = thrownSync(() =>
            t.provider.verifyWebhook(rawBody, headers, {
              ...t.creds,
              webhookSecret: 'another-secret',
            })
          );
          expect(err.code).toBe('WEBHOOK_BAD_SIGNATURE');
        });

        it('refuses a TAMPERED body (amount changed after signing)', async () => {
          const created = await t.provider.createPayment(
            baseRequest({ amountMinor: 50_000 }),
            t.creds
          );
          await ctl().capture(created.providerRef);
          const { rawBody, headers } = ctl().paymentWebhook(created.providerRef);
          // Swap the amount for a cheaper one, keep the old signature.
          const tampered = rawBody.replace('"amount":"500.00"', '"amount":"5.00"');
          expect(tampered).not.toBe(rawBody);
          expect(thrownSync(() => t.provider.verifyWebhook(tampered, headers, t.creds)).code).toBe(
            'WEBHOOK_BAD_SIGNATURE'
          );
          // ... and a re-signed-by-nobody status flip.
          const flipped = rawBody.replace('"state":"paid"', '"state":"failed"');
          expect(thrownSync(() => t.provider.verifyWebhook(flipped, headers, t.creds)).code).toBe(
            'WEBHOOK_BAD_SIGNATURE'
          );
        });

        it('a replayed delivery verifies to the IDENTICAL event id, so the inbox dedupes it to a no-op', async () => {
          const created = await t.provider.createPayment(baseRequest(), t.creds);
          await ctl().capture(created.providerRef);
          const { rawBody, headers } = ctl().paymentWebhook(created.providerRef);
          const first = t.provider.verifyWebhook(rawBody, headers, t.creds);
          const replay = t.provider.verifyWebhook(rawBody, headers, t.creds);
          expect(replay).toEqual(first);
          // Distinct events never share an id (else the inbox would drop a real one).
          const other = ctl().paymentWebhook(created.providerRef);
          expect(t.provider.verifyWebhook(other.rawBody, other.headers, t.creds).eventId).not.toBe(
            first.eventId
          );
        });

        it('maps provider states to PaymentStatus', async () => {
          const created = await t.provider.createPayment(baseRequest(), t.creds);
          const states: Array<['pending' | 'failed' | 'expired', PaymentStatus]> = [
            ['pending', 'pending'],
            ['failed', 'failed'],
            ['expired', 'expired'],
          ];
          for (const [state, expected] of states) {
            const { rawBody, headers } = ctl().paymentWebhook(created.providerRef, { state });
            const ev = t.provider.verifyWebhook(rawBody, headers, t.creds);
            expect(ev.kind === 'payment' && ev.status).toBe(expected);
          }
        });
      } else {
        it('has no webhook: verifyWebhook refuses everything and never returns an event', () => {
          const err = thrownSync(() =>
            t.provider.verifyWebhook('{"anything":true}', { signature: 'x' }, t.creds)
          );
          expect(err.code).toBe('WEBHOOK_BAD_SIGNATURE');
        });
      }
    });

    describe('status', () => {
      if (caps.remoteStatus) {
        it('maps pending -> completed with the captured amount', async () => {
          const created = await t.provider.createPayment(
            baseRequest({ amountMinor: 7_777 }),
            t.creds
          );
          const before = await t.provider.getStatus(created.providerRef, t.creds);
          expect(before.status).toBe('pending');
          expect(before.capturedMinor).toBe(0);
          await t.control!.capture(created.providerRef);
          const after = await t.provider.getStatus(created.providerRef, t.creds);
          expect(after.status).toBe('completed');
          expect(after.capturedMinor).toBe(7_777);
          expect(after.refundedMinor).toBe(0);
        });

        it('an unknown reference is PAYMENT_NOT_FOUND', async () => {
          const err = await rejection(t.provider.getStatus('does-not-exist', t.creds));
          expect(err.code).toBe('PAYMENT_NOT_FOUND');
        });
      } else {
        it('has no provider status: getStatus refuses', async () => {
          const err = await rejection(t.provider.getStatus('whatever', t.creds));
          expect(err.code).toBe('STATUS_NOT_SUPPORTED');
        });
      }
    });

    describe('refunds', () => {
      if (!caps.refunds) {
        it('has no provider refund: refund and partialRefund refuse', async () => {
          const a = await rejection(
            t.provider.refund({ providerRef: 'x', idempotencyKey: 'k1' }, t.creds)
          );
          const b = await rejection(
            t.provider.partialRefund(
              { providerRef: 'x', idempotencyKey: 'k2', amountMinor: 100 },
              t.creds
            )
          );
          expect([a.code, b.code]).toEqual(['REFUND_NOT_SUPPORTED', 'REFUND_NOT_SUPPORTED']);
        });
        return;
      }

      const paid = async (amountMinor: number) => {
        const created = await t.provider.createPayment(baseRequest({ amountMinor }), t.creds);
        await t.control!.capture(created.providerRef);
        return created.providerRef;
      };

      it('refuses to refund a payment that was never captured', async () => {
        const created = await t.provider.createPayment(baseRequest(), t.creds);
        const err = await rejection(
          t.provider.partialRefund(
            { providerRef: created.providerRef, idempotencyKey: 'rk-unpaid', amountMinor: 100 },
            t.creds
          )
        );
        expect(err.code).toBe('PAYMENT_NOT_CAPTURED');
      });

      if (caps.partialRefunds) {
        it('partial refunds sum to at most what was captured, to the piastre', async () => {
          const ref = await paid(10_001);
          const parts = [3_333, 3_333, 3_335]; // 10_001 exactly; no thirds-of-a-piastre drift
          let total = 0;
          for (const [i, amountMinor] of parts.entries()) {
            const r = await t.provider.partialRefund(
              { providerRef: ref, idempotencyKey: `rk-${i}`, amountMinor },
              t.creds
            );
            total += amountMinor;
            expect(r.amountMinor).toBe(amountMinor);
            expect(r.refundedTotalMinor).toBe(total);
          }
          const st = await t.provider.getStatus(ref, t.creds);
          expect(st.refundedMinor).toBe(10_001);
          expect(st.capturedMinor).toBe(10_001);
          expect(st.status).toBe('refunded');
        });

        it('one piastre over the captured total is refused and changes nothing', async () => {
          const ref = await paid(5_000);
          await t.provider.partialRefund(
            { providerRef: ref, idempotencyKey: 'a', amountMinor: 4_999 },
            t.creds
          );
          const err = await rejection(
            t.provider.partialRefund(
              { providerRef: ref, idempotencyKey: 'b', amountMinor: 2 },
              t.creds
            )
          );
          expect(err.code).toBe('REFUND_EXCEEDS_CAPTURED');
          const st = await t.provider.getStatus(ref, t.creds);
          expect(st.refundedMinor).toBe(4_999);
          expect(st.status).toBe('partially_refunded');
        });

        it('a partial refund is idempotent on its key: replay refunds once', async () => {
          const ref = await paid(8_000);
          const req = { providerRef: ref, idempotencyKey: 'same-key', amountMinor: 3_000 };
          const a = await t.provider.partialRefund(req, t.creds);
          const b = await t.provider.partialRefund({ ...req }, t.creds);
          expect(b.refundRef).toBe(a.refundRef);
          expect(b.refundedTotalMinor).toBe(3_000);
          expect((await t.provider.getStatus(ref, t.creds)).refundedMinor).toBe(3_000);
        });

        it('a full refund after partials returns only the remainder', async () => {
          const ref = await paid(9_000);
          await t.provider.partialRefund(
            { providerRef: ref, idempotencyKey: 'p1', amountMinor: 2_500 },
            t.creds
          );
          const full = await t.provider.refund(
            { providerRef: ref, idempotencyKey: 'full' },
            t.creds
          );
          expect(full.amountMinor).toBe(6_500);
          expect(full.refundedTotalMinor).toBe(9_000);
        });

        it('refuses a zero, negative or fractional refund amount', async () => {
          const ref = await paid(5_000);
          for (const amountMinor of [0, -1, 10.5, Number.NaN]) {
            const err = await rejection(
              t.provider.partialRefund(
                { providerRef: ref, idempotencyKey: `bad-${amountMinor}`, amountMinor },
                t.creds
              )
            );
            expect(err.code).toBe('AMOUNT_INVALID');
          }
          expect((await t.provider.getStatus(ref, t.creds)).refundedMinor).toBe(0);
        });
      } else {
        it('partialRefund refuses when partial refunds are not supported', async () => {
          const ref = await paid(5_000);
          const err = await rejection(
            t.provider.partialRefund(
              { providerRef: ref, idempotencyKey: 'x', amountMinor: 100 },
              t.creds
            )
          );
          expect(err.code).toBe('REFUND_NOT_SUPPORTED');
        });
      }

      it('a full refund is idempotent on its key', async () => {
        const ref = await paid(4_321);
        const a = await t.provider.refund(
          { providerRef: ref, idempotencyKey: 'full-key' },
          t.creds
        );
        const b = await t.provider.refund(
          { providerRef: ref, idempotencyKey: 'full-key' },
          t.creds
        );
        expect(b.refundRef).toBe(a.refundRef);
        expect(b.refundedTotalMinor).toBe(4_321);
        expect((await t.provider.getStatus(ref, t.creds)).refundedMinor).toBe(4_321);
      });
    });

    describe('outage', () => {
      if (!hasControl) {
        it('has no network, so there is nothing that can time out', () => {
          expect(t.provider.capabilities.remoteStatus).toBe(false);
          expect(t.provider.capabilities.webhooks).toBe(false);
        });
        return;
      }

      it('a timeout is a typed outage, creates nothing, and a same-key retry yields exactly one payment', async () => {
        const req = baseRequest();
        t.control!.injectNextCall('timeout');
        const err = await rejection(t.provider.createPayment(req, t.creds));
        expect(err.code).toBe('PROVIDER_TIMEOUT');
        expect(err.isOutage).toBe(true);
        expect(t.control!.providerPaymentCount()).toBe(0);

        const ok = await t.provider.createPayment(req, t.creds);
        expect(ok.amountMinor).toBe(req.amountMinor);
        expect(t.control!.providerPaymentCount()).toBe(1);
      });

      it('an unreachable provider is a typed outage', async () => {
        t.control!.injectNextCall('unavailable');
        const err = await rejection(t.provider.createPayment(baseRequest(), t.creds));
        expect(err.code).toBe('PROVIDER_UNAVAILABLE');
        expect(err.isOutage).toBe(true);
        expect(t.control!.providerPaymentCount()).toBe(0);
      });

      it('a rejection is NOT an outage (it must not trip the circuit breaker)', async () => {
        t.control!.injectNextCall('rejected');
        const err = await rejection(t.provider.createPayment(baseRequest(), t.creds));
        expect(err.code).toBe('PROVIDER_REJECTED');
        expect(err.isOutage).toBe(false);
      });

      it('a timed-out status read and refund are outages too, and move no money', async () => {
        const created = await t.provider.createPayment(
          baseRequest({ amountMinor: 6_000 }),
          t.creds
        );
        await t.control!.capture(created.providerRef);
        t.control!.injectNextCall('timeout');
        expect((await rejection(t.provider.getStatus(created.providerRef, t.creds))).code).toBe(
          'PROVIDER_TIMEOUT'
        );
        t.control!.injectNextCall('timeout');
        const err = await rejection(
          t.provider.refund({ providerRef: created.providerRef, idempotencyKey: 'r-to' }, t.creds)
        );
        expect(err.code).toBe('PROVIDER_TIMEOUT');
        expect((await t.provider.getStatus(created.providerRef, t.creds)).refundedMinor).toBe(0);
      });
    });
  });
}
