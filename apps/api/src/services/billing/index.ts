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
  // An explicit trial mode the provider cannot honour is a config error: stop at boot.
  if ((env.BILLING_TRIAL_CARD_MODE ?? '').trim() !== '' && (env.BILLING_PROVIDER ?? '').trim()) {
    resolveTrialCardMode(createBillingProvider(resolveBillingProviderName(env), env), env);
  }
}

/**
 * How the signup trial secures payment (Ruling EBDA-FUNNEL-2):
 *  - `card_on_file`: a card is saved with NOTHING charged before the store may go
 *    live; the trial-end job charges it on day 15.
 *  - `pay_at_trial_end`: no card during the trial; at trial end the merchant pays
 *    the chosen plan on the hosted checkout (dunning window, then downgrade).
 *
 * `BILLING_TRIAL_CARD_MODE` picks one explicitly; unset follows the provider's
 * capability. `card_on_file` on a provider that cannot save a card without a
 * charge is refused (it would block every go-live, or charge at signup).
 */
export type TrialCardMode = 'card_on_file' | 'pay_at_trial_end';

export function resolveTrialCardMode(
  provider?: Pick<BillingProvider, 'name' | 'capabilities'>,
  env: Env = process.env
): TrialCardMode {
  const raw = (env.BILLING_TRIAL_CARD_MODE ?? '').trim().toLowerCase();
  // InstaPay-only by default (Ahmad, 2026-10-07: no card gateway account yet):
  // the card option exists only when explicitly turned on (Ruling EBDA-FUNNEL-17).
  if (raw === '' || raw === 'pay_at_trial_end') return 'pay_at_trial_end';
  if (raw === 'card_on_file') {
    // Resolved only when card mode is requested: InstaPay-only never needs a gateway.
    const p = provider ?? getBillingProvider();
    const capable = p.capabilities.cardSetupWithoutCharge;
    if (!capable) {
      throw new Error(
        `BILLING_TRIAL_CARD_MODE=card_on_file but provider "${p.name}" cannot save a card without a charge`
      );
    }
    return 'card_on_file';
  }
  throw new Error(
    `Unknown BILLING_TRIAL_CARD_MODE "${raw}" (expected card_on_file|pay_at_trial_end)`
  );
}
