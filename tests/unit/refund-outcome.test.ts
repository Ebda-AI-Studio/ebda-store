/**
 * Telling "the provider refused" from "we don't know what the provider did"
 * (#1359).
 *
 * PaymentService.refund releases its claim — and lets the merchant retry — only
 * for a failure that proves nothing was sent. Every provider used to throw the
 * same bare Error for a 400 and for a timeout, so a timeout (the case where the
 * refund most likely DID go out) was released and retried: a second real
 * refund. The providers now say which it was.
 */
import { describe, it, expect } from 'vitest';
import {
  ProviderRejectedError,
  providerRequestError,
  markRefundMayHaveExecuted,
  refundMayHaveExecuted,
} from '@api/services/payment-providers/refund-outcome';
import { V2ProviderBridge } from '@api/services/payment-providers/v2-bridge';
import { createPaymobProvider } from '@api/services/payment-providers/paymob.provider';
import { createKashierProvider } from '@api/services/payment-providers/kashier.provider';
import { createFawryProvider } from '@api/services/payment-providers/fawry.provider';
import type { FetchLike } from '@api/services/payment-providers/gateway-http';
import type { PaymentProviderV2, ProviderCredentials } from '@api/services/payment-providers/types';
import { PaymobStub, PAYMOB_STUB } from '../stubs/paymob-stub';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { FawryStub, FAWRY_STUB } from '../stubs/fawry-stub';

describe('providerRequestError', () => {
  it.each([
    [400, false, true],
    [404, false, true],
    [422, false, true],
    [200, true, true], // HTTP fine, body says no — the provider decided
    [408, false, false], // the server gave up on the request, it did not decide
    [500, false, false],
    [502, false, false],
    [504, false, false],
  ])('status %s (responseOk=%s) → rejected=%s', (status, ok, rejected) => {
    const err = providerRequestError('x', status, ok);
    expect(err instanceof ProviderRejectedError).toBe(rejected);
    expect(err.message).toBe('x');
  });
});

describe('refundMayHaveExecuted', () => {
  it('is false unless PaymentService marked the error', () => {
    const plain = new Error('boom');
    expect(refundMayHaveExecuted(plain)).toBe(false);
    expect(refundMayHaveExecuted(markRefundMayHaveExecuted(plain))).toBe(true);
    expect(refundMayHaveExecuted(null)).toBe(false);
    expect(refundMayHaveExecuted('string')).toBe(false);
  });
});

/**
 * Each Egyptian adapter, behind the bridge PaymentService.refund calls, with a PAID payment and a
 * transport that can fail on the Nth gateway call. The first call of a refund is the status read
 * (the adapter works out what is still refundable), the second is the refund itself.
 */
interface Rig {
  bridge: V2ProviderBridge;
  transactionId: string;
  failOnCall(n: number, how: 'reject-4xx' | 'server-5xx' | 'timeout' | 'unreachable'): void;
}

async function rig(name: 'paymob' | 'kashier' | 'fawry'): Promise<Rig> {
  let calls = 0;
  let plan: { n: number; how: string } | null = null;
  const wrap =
    (inner: FetchLike): FetchLike =>
    async (url, init) => {
      calls += 1;
      if (plan && calls === plan.n) {
        if (plan.how === 'reject-4xx') return new Response('{"message":"no"}', { status: 422 });
        if (plan.how === 'server-5xx') return new Response('{"message":"boom"}', { status: 502 });
        if (plan.how === 'unreachable') throw new TypeError('fetch failed');
        await new Promise(() => undefined); // timeout: never answers
      }
      return inner(url, init);
    };
  const opts = { timeoutMs: 40 };
  let adapter: PaymentProviderV2;
  let creds: ProviderCredentials;
  let capture: (ref: string) => void;
  if (name === 'paymob') {
    const stub = new PaymobStub();
    adapter = createPaymobProvider({
      ...opts,
      fetchImpl: wrap(stub.fetch),
      baseUrls: { sandbox: PAYMOB_STUB.baseUrl },
    });
    creds = {
      mode: 'sandbox',
      apiKey: PAYMOB_STUB.secretKey,
      webhookSecret: PAYMOB_STUB.hmacSecret,
      settings: { publicKey: PAYMOB_STUB.publicKey, integrationIds: PAYMOB_STUB.integrationIds },
    };
    capture = ref => void stub.capture(Number(ref));
  } else if (name === 'kashier') {
    const stub = new KashierStub();
    adapter = createKashierProvider({
      ...opts,
      fetchImpl: wrap(stub.fetch),
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    });
    creds = {
      mode: 'sandbox',
      merchantId: KASHIER_STUB.merchantId,
      apiKey: KASHIER_STUB.apiKey,
      secretKey: KASHIER_STUB.secretKey,
    };
    capture = ref => stub.capture(ref);
  } else {
    const stub = new FawryStub();
    adapter = createFawryProvider({
      ...opts,
      fetchImpl: wrap(stub.fetch),
      baseUrls: { sandbox: FAWRY_STUB.baseUrl },
    });
    creds = { mode: 'sandbox', merchantId: FAWRY_STUB.merchantCode, apiKey: FAWRY_STUB.secureKey };
    capture = ref => stub.capture(ref);
  }
  const created = await adapter.createPayment(
    {
      orderId: 'o-1',
      orderNumber: 'ORD-1',
      amountMinor: 10_000,
      currency: 'EGP',
      customer: { name: 'A B', email: 'a@b.test', phone: '+201012345678' },
      returnUrls: { success: 'https://s.test/ok', failure: 'https://s.test/no' },
      idempotencyKey: `k-${name}`,
    },
    creds
  );
  capture(created.providerRef);
  calls = 0;
  return {
    bridge: new V2ProviderBridge(adapter, creds),
    transactionId: created.providerRef,
    failOnCall: (n, how) => {
      plan = { n, how };
      calls = 0;
    },
  };
}

describe.each(['paymob', 'kashier', 'fawry'] as const)(
  'adapter refund failures are classified (%s)',
  name => {
    it('the gateway refusing the refund is a REJECTION (nothing moved: the claim may be released)', async () => {
      const r = await rig(name);
      r.failOnCall(2, 'reject-4xx');
      await expect(
        r.bridge.refund({ transactionId: r.transactionId, amount: 1_000 })
      ).rejects.toBeInstanceOf(ProviderRejectedError);
    });

    it.each(['server-5xx', 'timeout', 'unreachable'] as const)(
      'a %s on the refund call may have executed: NOT a rejection (the claim is kept)',
      async how => {
        const r = await rig(name);
        r.failOnCall(2, how);
        const err = await r.bridge
          .refund({ transactionId: r.transactionId, amount: 1_000 })
          .catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(ProviderRejectedError);
      }
    );

    it('a failure BEFORE the refund call (the status read) means nothing was sent', async () => {
      const r = await rig(name);
      r.failOnCall(1, 'reject-4xx');
      await expect(
        r.bridge.refund({ transactionId: r.transactionId, amount: 1_000 })
      ).rejects.toBeInstanceOf(ProviderRejectedError);
    });
  }
);
