import { KashierBillingProvider, KASHIER_SANDBOX_URL } from './kashier.provider';
import { StubBillingProvider, STUB_WEBHOOK_SECRET } from './stub.provider';
import type { BillingProvider, BillingProviderName } from './types';

export * from './types';
export { KashierBillingProvider, StubBillingProvider, STUB_WEBHOOK_SECRET };

type Env = Record<string, string | undefined>;

/**
 * Which provider `BILLING_PROVIDER` selects. Unset = `stub` outside production
 * and an ERROR in production (money must never silently run on the stub).
 * `stub` with NODE_ENV=production is refused outright.
 */
export function resolveBillingProviderName(env: Env = process.env): BillingProviderName {
  const raw = (env.BILLING_PROVIDER ?? '').trim().toLowerCase();
  const production = env.NODE_ENV === 'production';
  if (raw === 'stub') {
    if (production) {
      throw new Error('BILLING_PROVIDER=stub is forbidden when NODE_ENV=production');
    }
    return 'stub';
  }
  if (raw === 'kashier') return 'kashier';
  if (raw === '') {
    if (production) {
      throw new Error('BILLING_PROVIDER must be set to "kashier" in production');
    }
    return 'stub';
  }
  throw new Error(`Unknown BILLING_PROVIDER "${raw}" (expected kashier|stub)`);
}

export function createBillingProvider(
  name: BillingProviderName,
  env: Env = process.env
): BillingProvider {
  if (name === 'stub') {
    if (env.NODE_ENV === 'production') {
      throw new Error('BILLING_PROVIDER=stub is forbidden when NODE_ENV=production');
    }
    return new StubBillingProvider();
  }
  return new KashierBillingProvider({
    baseUrl: env.KASHIER_BASE_URL || KASHIER_SANDBOX_URL,
    merchantId: env.KASHIER_MERCHANT_ID ?? '',
    secretKey: env.KASHIER_SECRET_KEY ?? '',
    apiKey: env.KASHIER_API_KEY ?? '',
  });
}

let cached: BillingProvider | null = null;
let override: BillingProvider | null = null;

/** The configured provider (process-wide singleton). */
export function getBillingProvider(): BillingProvider {
  if (override) return override;
  if (!cached) cached = createBillingProvider(resolveBillingProviderName());
  return cached;
}

/** The adapter for a webhook URL's `:provider` segment, or null if it is not usable here. */
export function getBillingProviderByName(name: string): BillingProvider | null {
  if (name !== 'kashier' && name !== 'stub') return null;
  const active = getBillingProvider();
  if (active.name === name) return active;
  // Allow a Kashier webhook while the stub is active (and vice versa) only
  // outside production; in production only the configured provider answers.
  if (process.env.NODE_ENV === 'production') return null;
  return createBillingProvider(name);
}

/** Test seam: inject a provider (or null to restore env selection). */
export function setBillingProviderForTests(p: BillingProvider | null): void {
  override = p;
  cached = null;
}

/**
 * Boot-time guard: an explicit `BILLING_PROVIDER=stub` in production must stop
 * the process (never run real subscriptions on the fake gateway). An UNSET value
 * in production does not stop boot — billing calls fail until it is configured.
 */
export function assertBillingConfigAtBoot(env: Env = process.env): void {
  if ((env.BILLING_PROVIDER ?? '').trim().toLowerCase() === 'stub') {
    resolveBillingProviderName(env);
  }
}
