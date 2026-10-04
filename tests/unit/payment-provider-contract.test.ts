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
