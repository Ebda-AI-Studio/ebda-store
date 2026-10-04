/**
 * The shared payment-provider contract (tests/contract/payment-provider.contract.ts)
 * run against every adapter that exists today: the in-memory stub gateway (the full
 * contract), COD and InstaPay (the no-network subset, plus the refusals asserted).
 * 6b adds Paymob / Kashier / Fawry here, each with its own stub.
 */
import { runPaymentProviderContract } from '../contract/payment-provider.contract';
import {
  createStubControl,
  createStubProvider,
  StubGateway,
  STUB_WEBHOOK_SECRET,
} from '../contract/stub-provider';
import { createPaymobProvider } from '@api/services/payment-providers/paymob.provider';
import { createPaymobControl, PaymobStub, PAYMOB_STUB } from '../stubs/paymob-stub';
import { createKashierProvider } from '@api/services/payment-providers/kashier.provider';
import { createKashierControl, KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { createFawryProvider } from '@api/services/payment-providers/fawry.provider';
import { createFawryControl, FawryStub, FAWRY_STUB } from '../stubs/fawry-stub';
import { codProvider } from '@api/services/payment-providers/cod.provider';
import { instapayProvider } from '@api/services/payment-providers/instapay.provider';

runPaymentProviderContract('stub gateway', () => {
  const gateway = new StubGateway();
  return {
    provider: createStubProvider(gateway),
    creds: { mode: 'sandbox', apiKey: 'k', webhookSecret: STUB_WEBHOOK_SECRET },
    control: createStubControl(gateway),
  };
});

runPaymentProviderContract('cod', () => ({
  provider: codProvider,
  creds: { mode: 'live' },
}));

runPaymentProviderContract('instapay', () => ({
  provider: instapayProvider,
  creds: {
    mode: 'live',
    settings: { handle: 'amelia@instapay', phone: '01012345678', expiryHours: 48 },
  },
}));

runPaymentProviderContract('paymob (Intention API stub)', () => {
  const stub = new PaymobStub();
  return {
    provider: createPaymobProvider({
      fetchImpl: stub.fetch,
      timeoutMs: 50,
      baseUrls: { sandbox: PAYMOB_STUB.baseUrl },
    }),
    creds: {
      mode: 'sandbox',
      apiKey: PAYMOB_STUB.secretKey,
      webhookSecret: PAYMOB_STUB.hmacSecret,
      settings: { publicKey: PAYMOB_STUB.publicKey, integrationIds: PAYMOB_STUB.integrationIds },
    },
    control: createPaymobControl(stub),
  };
});

runPaymentProviderContract('kashier (hosted session stub)', () => {
  const stub = new KashierStub();
  return {
    provider: createKashierProvider({
      fetchImpl: stub.fetch,
      timeoutMs: 50,
      baseUrls: { sandbox: KASHIER_STUB.baseUrl },
    }),
    creds: {
      mode: 'sandbox',
      merchantId: KASHIER_STUB.merchantId,
      apiKey: KASHIER_STUB.apiKey,
      secretKey: KASHIER_STUB.secretKey,
      settings: { methods: ['card', 'wallet'], display: 'en' },
    },
    control: createKashierControl(stub),
  };
});

runPaymentProviderContract('fawry (reference-code stub)', () => {
  const stub = new FawryStub();
  return {
    provider: createFawryProvider({
      fetchImpl: stub.fetch,
      timeoutMs: 50,
      baseUrls: { sandbox: FAWRY_STUB.baseUrl },
    }),
    creds: {
      mode: 'sandbox',
      merchantId: FAWRY_STUB.merchantCode,
      apiKey: FAWRY_STUB.secureKey,
      settings: { methods: ['payatfawry', 'card'], expiryHours: 72 },
    },
    control: createFawryControl(stub),
  };
});
