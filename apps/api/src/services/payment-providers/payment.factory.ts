import crypto from 'crypto';
import { currentStoreId, prisma, Prisma, runInTenantContext, withStore } from '@ebda/database';
import { config } from '../../config';
import { AppError } from '../../middleware/error-handler';
import logger from '../../lib/logger';
import { OrderService, assertValidTransition } from '../order.service';
import {
  claimOrderFailed,
  claimOrderPaid,
  lockPaymentRow,
  paymentStatusesNotOverwrittenBy,
} from '../payment-state-claims';
import { socketService } from '../socket.service';
import { inngest } from '../../lib/inngest/client';
import { OneSignalService } from '../onesignal.service';
import { redis } from '../redis.service';
import { CardTestingGuard } from '../card-testing-guard.service';
import { sendAlert } from '../alerts.service';
import { alertUnbookedRefund } from './unbooked-refund-alert';
import { alertOrphanedProviderInvoice } from './orphaned-invoice-alert';
import { recordPaymentEvent } from '../payment-event.service';
import { invalidateCustomersCache } from '../../lib/public-cache';
import { buildPaymentLineItems } from '../../lib/payment-line-items';
import {
  IPaymentProvider,
  PaymentProvider,
  CreatePaymentRequest,
  PaymentResponse,
  PaymentStatusResponse,
  RefundRequest,
  RefundResponse,
  AvailablePaymentMethod,
  Currency,
} from './types';
import { callThroughBreaker } from './provider-health';
import { withProviderDeadline } from './provider-call';
import { getProviderV2, MANUAL_PROVIDERS } from './registry';
import { toProviderCredentials } from './credentials';
import { isOfferableAtCheckout, isProviderUsable } from './provider-gate';
import { recordPaymentSettled, recordProviderOperation } from '../provider-verification.service';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';
import { V2ProviderBridge } from './v2-bridge';
import { PaymentProviderError, type WebhookPayload } from './types';
import type { PaymentStatus as DbPaymentStatus } from '@ebda/database';
import {
  resolveRefundSettlement,
  readAccountedRefundEventIds,
  appendRefundEventId,
  REFUND_EVENT_IDS_KEY,
  REFUND_STATUS_BY_ID_KEY,
  isRefundEventAlreadySeen,
  recordRefundStatus,
} from './refund-settlement';
import {
  ProviderRejectedError,
  markRefundMayHaveExecuted,
  REFUND_CLAIM_EVENT,
  REFUND_EXECUTED_EVENT,
  REFUND_RELEASED_EVENT,
  REFUND_INDETERMINATE_EVENT,
  REFUND_RECONCILED_EVENT,
  REFUND_REVIEW_EVENT,
  REFUND_ABSORBED_EVENT,
} from './refund-outcome';
import {
  settleRefundEvent,
  settleClaimRelease,
  inSettlementTx,
  lockPayment,
  absorbedRefundIdFor,
} from './refund-settle';

import { REGION } from '@ebda/shared';
import { paymentWebhookUrl } from './webhook-url';
import {
  storeDb,
  storeMoney,
  storeRepo,
  type MoneyClient,
  type DoWebhookInput,
} from '../../lib/repo-factory';
// ==========================================
// Payment Factory
// Database-driven configuration for payment providers
// Supports both global and per-store configurations
// ==========================================

/** Money-integrity F3 (2026-07-02 audit): reconciliation tolerance (minor
 *  units = piastres) for a provider-reported paid amount vs the expected
 *  `Payment.amount`. See the `isAmountUnderpaid` check in `handleWebhook` for
 *  the unit note (both sides are minor units). 5 piastres (0.05 EGP) of
 *  rounding allowance, same bound as payment-confirm.service.ts.
 *  Every Egyptian adapter converts with `toMinor` / `minorToDecimalString`
 *  (single currencyExponent, integer string math) at its own edge. */
const AMOUNT_TOLERANCE_FILS = 5;

interface ProviderConfig {
  provider: PaymentProvider;
  apiKey: string;
  secretKey?: string;
  merchantId?: string;
  webhookSecret?: string;
  isTestMode: boolean;
  isEnabled: boolean;
  isDefault: boolean;
  displayName?: string;
  displayNameAr?: string;
  supportedMethods: string[];
  supportedCurrencies: string[];
  fixedFee: number;
  percentageFee: number;
  /** Non-secret per-provider settings (Paymob integration ids, Fawry methods, ...). */
  settings: Record<string, unknown>;
}

interface CachedProviders {
  providers: Map<PaymentProvider, IPaymentProvider>;
  defaultProvider: PaymentProvider | null;
  configs: Map<PaymentProvider, ProviderConfig>;
  timestamp: number;
}

class PaymentFactory {
  // Cache providers by storeId (null = global)
  private cache: Map<string | null, CachedProviders> = new Map();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes
  private initializationPromises: Map<string | null, Promise<void>> = new Map();

  /**
   * Get or initialize providers for a store (or global if storeId is null)
   */
  async getProviders(storeId?: string | null): Promise<CachedProviders> {
    const cacheKey = storeId || null;
    const cached = this.cache.get(cacheKey);

    // Return cached if valid
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached;
    }

    // Check if already initializing to prevent concurrent initialization
    const existingPromise = this.initializationPromises.get(cacheKey);
    if (existingPromise) {
      await existingPromise;
      return this.cache.get(cacheKey)!;
    }

    // Initialize providers
    const initPromise = this.initializeProviders(cacheKey);
    this.initializationPromises.set(cacheKey, initPromise);

    try {
      await initPromise;
      return this.cache.get(cacheKey)!;
    } finally {
      this.initializationPromises.delete(cacheKey);
    }
  }

  /**
   * Initialize providers from database configuration
   */
  private async initializeProviders(storeId: string | null): Promise<void> {
    const providers = new Map<PaymentProvider, IPaymentProvider>();
    const configs = new Map<PaymentProvider, ProviderConfig>();
    let defaultProvider: PaymentProvider | null = null;

    try {
      // A store's providers come only from ITS OWN paymentConfig rows, read inside that
      // store's scope (`withStore`: it reuses the request's transaction when one is open
      // for the same store, otherwise it opens a short one). Without the scope the first
      // caller outside a transaction (the storefront's GET /payments/config) cached "no
      // providers" for five minutes and every online checkout failed (SP6a).
      //
      // There are no platform-level (storeId NULL) configs for the app role: strict RLS
      // hides NULL-store rows and the code-level tenant guard refuses an unscoped read
      // (R-EBDA-007), so the old "fall back to global" read could only ever return nothing.
      // A store on its Durable Object keeps its provider rows THERE (Ruling CF-JOBS-3): a job or webhook for it must read
      // that copy, not the sealed Postgres rows. `storeRepo` is the pg proxy for a Postgres store, so that path is unchanged.
      const repo = storeId === null ? null : await storeRepo(storeId);
      const dbConfigs =
        storeId === null
          ? []
          : repo?.backend === 'do'
            ? await repo.db.paymentConfig.findMany({
                where: { storeId, isEnabled: true },
                orderBy: { provider: 'asc' },
              })
            : await withStore(storeId, () =>
                prisma.paymentConfig.findMany({
                  where: {
                    storeId: storeId,
                    isEnabled: true,
                  },
                  orderBy: { provider: 'asc' },
                })
              );

      // There is NO environment-variable fallback: providers come only from a
      // paymentConfig row the merchant saved in settings (their own keys), so a
      // platform-level key can never make a gateway "available" to a tenant that did
      // not enable it.
      if (dbConfigs.length === 0 && storeId === null) {
        logger.info('[PAYMENT] No platform-level paymentConfig rows');
      } else if (dbConfigs.length === 0) {
        logger.info(
          { storeId },
          '[PAYMENT] No paymentConfig rows for store; no online providers available'
        );
      } else {
        // Initialize from database config
        for (const dbConfig of dbConfigs) {
          try {
            // COD and InstaPay have no gateway behind them: they are not factory providers.
            if (MANUAL_PROVIDERS.has(dbConfig.provider)) continue;

            // PROVIDERS-3 runtime gate: any provider the catalog knows is offered (verified or
            // not). The enable gate (`assertEnableAllowed`: a passing Test connection of exactly
            // the stored credentials, and a credential edit disables the row) is what keeps an
            // untested gateway from being enabled; this only drops a code the catalog no longer has.
            // GEIDEA-2: a provider Ebda cannot confirm is never offered to buyers (or created).
            if (!isOfferableAtCheckout(dbConfig.provider, storeId)) {
              logger.warn(
                { provider: dbConfig.provider, storeId },
                '[PAYMENT] Skipping provider: no confirmation path, hidden from checkout (GEIDEA-2)'
              );
              continue;
            }
            if (!isProviderUsable(dbConfig.provider)) {
              logger.warn(
                { provider: dbConfig.provider, storeId },
                '[PAYMENT] Skipping provider: not in the provider catalog'
              );
              continue;
            }

            // One decryption path for every reader (catalog blob, else the legacy columns).
            const creds = toProviderCredentials(dbConfig);
            const providerConfig: ProviderConfig = {
              provider: dbConfig.provider as PaymentProvider,
              apiKey: creds.apiKey ?? '',
              secretKey: creds.secretKey,
              merchantId: creds.merchantId,
              webhookSecret: creds.webhookSecret,
              isTestMode: dbConfig.testMode,
              isEnabled: dbConfig.isEnabled,
              isDefault: dbConfig.isDefault,
              displayName: dbConfig.displayName || undefined,
              displayNameAr: dbConfig.displayNameAr || undefined,
              supportedMethods: dbConfig.supportedMethods,
              supportedCurrencies: dbConfig.supportedCurrencies,
              fixedFee: Number(dbConfig.fixedFee),
              percentageFee: Number(dbConfig.percentageFee),
              settings: (creds.settings ?? {}) as Record<string, unknown>,
            };

            if (!providerConfig.apiKey) {
              logger.warn(
                { provider: dbConfig.provider },
                '[PAYMENT] Skipping provider: No API key configured'
              );
              continue;
            }

            const provider = this.createProvider(providerConfig);
            if (provider) {
              providers.set(providerConfig.provider, provider);
              configs.set(providerConfig.provider, providerConfig);

              if (dbConfig.isDefault) {
                defaultProvider = providerConfig.provider;
              }
            }
          } catch (error) {
            logger.error(
              { err: error, provider: dbConfig.provider },
              '[PAYMENT] Failed to initialize provider'
            );
          }
        }
      }

      // Set default provider if not explicitly set
      if (!defaultProvider && providers.size > 0) {
        defaultProvider = providers.keys().next().value || null;
      }

      logger.info(
        {
          storeId,
          providers: Array.from(providers.keys()).join(', ') || 'none',
          defaultProvider: defaultProvider || 'none',
        },
        '[PAYMENT] Initialized providers'
      );

      this.cache.set(storeId, {
        providers,
        configs,
        defaultProvider,
        timestamp: Date.now(),
      });
    } catch (error) {
      // A failed read is cached for 5 s only (not the full window): a transient error must
      // not hide every provider for five minutes, and there is no env fallback to cover it.
      logger.error({ err: error }, '[PAYMENT] Failed to initialize providers');
      this.cache.set(storeId, {
        providers: new Map(),
        configs: new Map(),
        defaultProvider: null,
        timestamp: Date.now() - this.cacheTimeout + 5_000,
      });
    }
  }

  /**
   * Build the provider for one merchant's config. The Egyptian gateways are v2 adapters
   * (`registry.ts`) wrapped by the bridge with THIS merchant's decrypted credentials; there
   * is no platform-level fallback, so no gateway is ever reachable with a key that is not the
   * merchant's own.
   */
  private createProvider(config: ProviderConfig): IPaymentProvider | null {
    try {
      const adapter = getProviderV2(config.provider);
      if (!adapter || MANUAL_PROVIDERS.has(config.provider)) {
        logger.warn({ provider: config.provider }, '[PAYMENT] Unknown provider');
        return null;
      }
      return new V2ProviderBridge(adapter, {
        apiKey: config.apiKey || undefined,
        secretKey: config.secretKey,
        merchantId: config.merchantId,
        webhookSecret: config.webhookSecret,
        mode: config.isTestMode ? 'sandbox' : 'live',
        settings: config.settings,
      });
    } catch (error) {
      logger.error(
        { err: error, provider: config.provider },
        '[PAYMENT] Failed to create provider'
      );
      return null;
    }
  }

  /**
   * Get a specific provider
   */
  async getProvider(
    provider?: PaymentProvider,
    storeId?: string | null
  ): Promise<IPaymentProvider> {
    const cached = await this.getProviders(storeId);
    const providerName = provider || cached.defaultProvider;

    if (!providerName) {
      throw new AppError(500, 'PAYMENT_NOT_CONFIGURED', 'No payment providers configured');
    }

    const p = cached.providers.get(providerName);

    if (!p) {
      throw new AppError(
        500,
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        `Payment provider '${providerName}' is not configured`
      );
    }

    return p;
  }

  /**
   * Get provider configuration
   */
  async getProviderConfig(
    provider: PaymentProvider,
    storeId?: string | null
  ): Promise<ProviderConfig | undefined> {
    const cached = await this.getProviders(storeId);
    return cached.configs.get(provider);
  }

  /**
   * Get available providers for a store
   */
  async getAvailableProviders(storeId?: string | null): Promise<PaymentProvider[]> {
    const cached = await this.getProviders(storeId);
    return Array.from(cached.providers.keys());
  }

  /**
   * Check if a provider is available
   */
  async isProviderAvailable(provider: PaymentProvider, storeId?: string | null): Promise<boolean> {
    const cached = await this.getProviders(storeId);
    return cached.providers.has(provider);
  }

  /**
   * Clear cache for a store (call when config changes)
   */
  clearCache(storeId?: string | null): void {
    if (storeId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(storeId);
    }
  }

  /**
   * Get default provider for a store
   */
  async getDefaultProvider(storeId?: string | null): Promise<PaymentProvider | null> {
    const cached = await this.getProviders(storeId);
    return cached.defaultProvider;
  }
}

// Singleton instance
const factory = new PaymentFactory();

/**
 * Duplicate-capture detector (adversarial audit P2): when a payment reaches a
 * captured state and ANOTHER payment on the same order is already captured
 * (completed / refunded / partially_refunded), real money was taken twice for
 * one order — e.g. two live invoices from a replayed /payments/create, both
 * paid. Nothing reconciled that combination before; the merchant found out
 * via a chargeback. Fires a P0 alert so finance refunds the duplicate before
 * the customer disputes. Best-effort by design: called with `await` but every
 * failure is swallowed — an alerting hiccup must never fail webhook
 * processing.
 */
/**
 * PROVIDERS-17: ask the gateway what a verified delivery really is, audit-log the answer, and
 * return the payload to APPLY (the confirmed one). Read-only at the gateway, so a redelivery or
 * a retry simply asks again: idempotent. Any failure throws a retriable 503 and applies nothing.
 */
export async function confirmBeforeApply(
  p: IPaymentProvider,
  webhookData: WebhookPayload,
  ctx: {
    provider: PaymentProvider;
    paymentId: string;
    paymentStatus: DbPaymentStatus;
    orderId: string;
    storeId: string;
  }
): Promise<WebhookPayload> {
  let out: Awaited<ReturnType<NonNullable<IPaymentProvider['confirmWebhook']>>>;
  try {
    out = await p.confirmWebhook!(webhookData);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        provider: ctx.provider,
        paymentId: ctx.paymentId,
        claimed: webhookData.refund ? `refund/${webhookData.refund.status}` : webhookData.status,
        reason,
      },
      '[PAYMENT WEBHOOK] could not confirm the delivery with the gateway — not applied, will retry'
    );
    // No payment-event row here: this throw rolls the tenant transaction back, so it would never
    // persist. The reason is kept on the durable inbox row instead (`lastError`, written by the
    // Inngest consumer or the inline fallback) and in this log line.
    throw new AppError(
      503,
      'WEBHOOK_UNCONFIRMED',
      `The gateway could not confirm this webhook; it was not applied and will be retried (${reason.slice(0, 200)})`
    );
  }
  const { confirmation } = out;
  await recordPaymentEvent({
    paymentId: ctx.paymentId,
    storeId: ctx.storeId,
    orderId: ctx.orderId,
    eventType: confirmation.mismatch ? 'webhook_corrected' : 'webhook_confirmed',
    fromStatus: ctx.paymentStatus,
    toStatus: null,
    provider: ctx.provider,
    details: {
      claimed: confirmation.claimed,
      confirmed: confirmation.confirmed,
      reason: confirmation.mismatch
        ? `delivery said ${confirmation.claimed.kind} ${confirmation.claimed.status}; gateway record ${confirmation.confirmed.kind} ${confirmation.confirmed.status} applied`
        : `gateway record ${confirmation.confirmed.kind} ${confirmation.confirmed.status}`,
      source: confirmation.source,
    },
  });
  if (confirmation.mismatch) {
    logger.error(
      {
        provider: ctx.provider,
        paymentId: ctx.paymentId,
        claimed: confirmation.claimed,
        confirmed: confirmation.confirmed,
      },
      '[PAYMENT WEBHOOK] delivery disagreed with the gateway record — applying the gateway record'
    );
    await sendAlert({
      level: 'p1',
      scope: 'store',
      store: { id: ctx.storeId, name: ctx.storeId },
      source: 'payment.webhook.unconfirmed_label',
      title: `${ctx.provider} webhook label disagreed with the gateway — payment ${ctx.paymentId}`,
      body:
        `A signed ${ctx.provider} delivery claimed ${confirmation.claimed.kind}/${confirmation.claimed.status}, ` +
        `but the gateway's own record says ${confirmation.confirmed.kind}/${confirmation.confirmed.status}. ` +
        'Only the gateway record was applied. A relabelled delivery is a sign of a replayed or tampered webhook.',
      context: {
        provider: ctx.provider,
        storeId: ctx.storeId,
        paymentId: ctx.paymentId,
        claimed: confirmation.claimed,
        confirmed: confirmation.confirmed,
      },
    }).catch(() => undefined);
  }
  return out.payload;
}

export async function alertIfDuplicateCapture(
  paymentId: string,
  orderId: string,
  provider: string
): Promise<void> {
  try {
    const duplicate = await prisma.payment.findFirst({
      where: {
        orderId,
        id: { not: paymentId },
        status: { in: ['completed', 'refunded', 'partially_refunded'] },
      },
      select: { id: true, provider: true, amount: true },
    });
    if (!duplicate) return;
    const order = await prisma.order.findUnique({
      where: { id: orderId, storeId: currentStoreId() },
      select: { storeId: true, store: { select: { name: true } } },
    });
    logger.error(
      { orderId, paymentId, duplicatePaymentId: duplicate.id, provider },
      '[PAYMENT WEBHOOK] duplicate capture detected — two captured payments on one order'
    );
    await sendAlert({
      level: 'p0',
      scope: 'store',
      store: {
        id: order?.storeId ?? '',
        name: order?.store?.name ?? order?.storeId ?? 'unknown',
      },
      source: 'payment.duplicate_capture',
      title: 'payment.duplicate_capture',
      body: `Order ${orderId}: payment ${paymentId} (${provider}) completed while payment ${duplicate.id} (${duplicate.provider}, ${duplicate.amount} piastres) is already captured. The customer likely paid twice — refund the duplicate before it becomes a dispute.`,
      context: { orderId, paymentId, duplicatePaymentId: duplicate.id, provider },
    });
  } catch (err) {
    logger.error({ err, orderId, paymentId }, '[PAYMENT WEBHOOK] duplicate-capture check failed');
  }
}

// ==========================================
// Refund ledger (payment_events)
// ==========================================

/**
 * Run `fn` in a transaction of its own that commits when `fn` resolves —
 * whatever later happens to the caller's request transaction. Inside it the
 * `prisma` proxy routes to the new transaction, with the store's RLS GUC set.
 * See PaymentService.refund for why the refund's records cannot share the
 * request's fate.
 */
function commitOnOwnTransaction<T>(storeId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return runInTenantContext(storeId, fn);
}

/**
 * Claim ids for `refundKey` on this payment that were never released — each is
 * a refund that went out, or may have. A released claim (the provider refused,
 * or the request was never sent) does not count.
 */
export async function findOutstandingRefundClaims(
  paymentId: string,
  refundKey: string,
  storeId: string
): Promise<string[]> {
  const rows = await prisma.paymentEvent.findMany({
    where: {
      storeId,
      paymentId,
      eventType: { in: [REFUND_CLAIM_EVENT, REFUND_RELEASED_EVENT] },
      details: { path: ['refundKey'], equals: refundKey },
    },
    select: { eventType: true, details: true },
  });
  const claimed = new Set<string>();
  const released = new Set<string>();
  for (const row of rows) {
    const id = (row.details as Record<string, unknown> | null)?.claimId;
    if (typeof id !== 'string') continue;
    (row.eventType === REFUND_CLAIM_EVENT ? claimed : released).add(id);
  }
  return [...claimed].filter(id => !released.has(id));
}

/**
 * Mark every still-open claim for `refundKey` on this order as settled by the
 * merchant (issue 2002). Called when a return is completed with a NON-gateway
 * method — the product's own recovery for an indeterminate refund ("Already
 * refunded — record only"). Without it the claim had no terminal state a human
 * could reach, and the stuck-claim sweep re-alerted it for a week.
 *
 * "Open" = claimed, and not yet executed, released or reconciled. Written on
 * the caller's (request) transaction, so it commits or rolls back with the
 * completion it records. Moves no money. Returns the claim ids it settled.
 */
export async function reconcileOutstandingRefundClaims(input: {
  storeId: string;
  orderId: string;
  refundKey: string;
  refundMethod: string;
  userId?: string | null;
}): Promise<string[]> {
  const rows = await prisma.paymentEvent.findMany({
    where: {
      orderId: input.orderId,
      storeId: input.storeId,
      eventType: {
        in: [
          REFUND_CLAIM_EVENT,
          REFUND_EXECUTED_EVENT,
          REFUND_RELEASED_EVENT,
          REFUND_RECONCILED_EVENT,
        ],
      },
      details: { path: ['refundKey'], equals: input.refundKey },
    },
    select: { eventType: true, details: true, paymentId: true, provider: true },
  });
  const claims = new Map<string, { paymentId: string; provider: string | null; amount: unknown }>();
  const closed = new Set<string>();
  for (const row of rows) {
    const d = (row.details as Record<string, unknown> | null) ?? {};
    const id = d.claimId;
    if (typeof id !== 'string') continue;
    if (row.eventType === REFUND_CLAIM_EVENT) {
      claims.set(id, { paymentId: row.paymentId, provider: row.provider, amount: d.amount });
    } else {
      closed.add(id);
    }
  }
  const open = [...claims].filter(([id]) => !closed.has(id));
  for (const [claimId, claim] of open) {
    await prisma.paymentEvent.create({
      data: {
        paymentId: claim.paymentId,
        storeId: input.storeId,
        orderId: input.orderId,
        eventType: REFUND_RECONCILED_EVENT,
        provider: claim.provider,
        // The actor rides in `details`, not the `triggeredByUserId` FK: a
        // bad FK here would abort the completion transaction this row is
        // recording (25P02) and take the return down with it.
        details: {
          reason: 'reconciled_by_merchant',
          claimId,
          amount: typeof claim.amount === 'number' ? claim.amount : null,
          refundKey: input.refundKey,
          refundMethod: input.refundMethod,
          reconciledBy: input.userId ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }
  return open.map(([id]) => id);
}

// ==========================================
// Unified Payment Service
// ==========================================

/** A short, secret-free code for an error (class code only, never a message or body). */
function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,60}$/.test(code)) return code;
  return err instanceof Error ? err.name.slice(0, 60) : 'UNKNOWN';
}

export class PaymentService {
  /**
   * Get available payment providers
   */
  static async getAvailableProviders(storeId?: string): Promise<PaymentProvider[]> {
    return factory.getAvailableProviders(storeId);
  }

  /**
   * Resolve the merchant's default payment provider for the given store.
   * Honors per-store PaymentProviderConfig.isEnabled + falls back to env
   * defaults via the same logic as `createPayment(undefined, storeId)`.
   * Returns null when no provider is configured (caller surfaces a
   * "configure a provider in Settings → Payments" error).
   *
   * Used by merchant-initiated flows (WhatsApp payment links, manual
   * refunds, etc.) that need to know the provider name BEFORE calling
   * createPayment — typically to build the provider-specific webhook URL.
   */
  static async getDefaultProvider(storeId?: string | null): Promise<PaymentProvider | null> {
    const cached = await factory.getProviders(storeId);
    return cached.defaultProvider ?? null;
  }

  /**
   * Non-secret, per-provider settings of a store's config (Paymob integration ids, Fawry
   * methods, ...). Never returns a credential: `ProviderConfig` holds the DECRYPTED keys.
   */
  static async getProviderSettings(
    provider: PaymentProvider,
    storeId?: string
  ): Promise<Record<string, unknown>> {
    return (await factory.getProviderConfig(provider, storeId))?.settings ?? {};
  }

  /**
   * Get payment methods for a specific provider. Only what a customer may see: the provider's
   * name, its methods, and the merchant's fees. The decrypted credentials the factory holds
   * are NEVER part of this answer: it is returned by a public route.
   */
  static async getPaymentMethods(
    amount: number,
    currency: Currency = REGION.currency as Currency,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<
    {
      provider: PaymentProvider;
      methods: AvailablePaymentMethod[];
      config?: { fixedFee: number; percentageFee: number };
    }[]
  > {
    const providers = provider ? [provider] : await factory.getAvailableProviders(storeId);
    const results: {
      provider: PaymentProvider;
      methods: AvailablePaymentMethod[];
      config?: { fixedFee: number; percentageFee: number };
    }[] = [];

    for (const p of providers) {
      try {
        const providerInstance = await factory.getProvider(p, storeId);
        const methods = await providerInstance.getPaymentMethods(amount, currency);
        const providerConfig = await factory.getProviderConfig(p, storeId);
        results.push({
          provider: p,
          methods,
          config: providerConfig
            ? { fixedFee: providerConfig.fixedFee, percentageFee: providerConfig.percentageFee }
            : undefined,
        });
      } catch (error) {
        logger.error(
          { err: error, provider: p },
          '[PAYMENT] Failed to get payment methods from provider'
        );
      }
    }

    return results;
  }

  /**
   * Create a payment: the provider call, then the record, for callers that have NO request
   * transaction open (an admin payment link, the agent's `place_order`, a retry): the provider
   * call runs with nothing held, then ONE short tenant transaction records the Payment row and
   * its audit event. The checkout calls the two halves itself (`requestProviderPayment`,
   * `recordProviderPayment`) because it also writes an audit log in the same short transaction.
   *
   * Never call this from inside `tenantContext` / `runInTenantContext`: the gateway call would
   * then hold that transaction (and a pooled connection) for as long as the gateway takes, and
   * Prisma expires it 30 s after BEGIN. Mount the route on `storeScopeContext` instead.
   */
  static async createPayment(
    request: CreatePaymentRequest,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<PaymentResponse> {
    const { providerName, response } = await PaymentService.requestProviderPayment(
      request,
      provider,
      storeId
    );
    // Short record transaction. Without a store there is nothing to scope (platform tests).
    if (storeId) {
      await runInTenantContext(storeId, () =>
        PaymentService.recordProviderPayment(providerName, request, response, storeId)
      );
    } else {
      await PaymentService.recordProviderPayment(providerName, request, response, storeId);
    }
    return response;
  }

  /**
   * HALF 1: ask the provider to open a payment. Writes NOTHING (the provider's
   * config and the attempt count are read in short store scopes) and must be called with no
   * request transaction open. Bounded by a deadline and run behind the
   * per-(store, provider) circuit breaker, so a slow or dead gateway fails one
   * method fast instead of holding a connection or stalling checkout.
   *
   * The adapter is idempotent on `metadata.idempotencyKey`. When the caller gives none, it is
   * `<order>:<provider>:<attempt>` where attempt is the number of payments the order already
   * has with this provider plus one: a retry of an attempt that timed out (no row written)
   * reuses the key, so it can never mint a second invoice, while a retry after a recorded
   * failure gets a fresh one.
   */
  static async requestProviderPayment(
    request: CreatePaymentRequest,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<{ providerName: PaymentProvider; response: PaymentResponse }> {
    const p = await factory.getProvider(provider, storeId);
    let keyed = request;
    if (!request.metadata?.idempotencyKey) {
      const prior = storeId
        ? await withStore(storeId, () =>
            prisma.payment.count({ where: { orderId: request.orderId, provider: p.name } })
          )
        : 0;
      keyed = {
        ...request,
        metadata: {
          ...request.metadata,
          idempotencyKey: `${request.orderId}:${p.name}:${prior + 1}`,
        },
      };
    }
    const call = () =>
      withProviderDeadline(`${p.name}.createPayment`, () => p.createPayment(keyed));
    let response: PaymentResponse;
    try {
      response = storeId ? await callThroughBreaker(storeId, p.name, call) : await call();
    } catch (err) {
      // PROVIDERS-3: a failed real call of a not-yet-verified provider pages ops (never throws).
      if (storeId) {
        void deferAfterTenantCommit(
          'provider-verify.create_payment.failed',
          () =>
            recordProviderOperation({
              storeId,
              provider: p.name,
              op: 'create_payment',
              ok: false,
              errorCode: errorCodeOf(err),
            }),
          { runOnRollback: true }
        );
      }
      throw err;
    }
    if (storeId) {
      void deferAfterTenantCommit('provider-verify.create_payment', () =>
        recordProviderOperation({
          storeId,
          provider: p.name,
          op: 'create_payment',
          ok: true,
          ref: response.transactionId ?? null,
        })
      );
    }
    return { providerName: p.name, response };
  }

  /**
   * HALF 2: record the accepted invoice (the Payment row + its `created` audit
   * event). The gateway ACCEPTED: from here the invoice is live at the provider
   * whatever happens to the writes below. If recording it throws (statement
   * timeout, connection blip, a constraint error), this method rejects — so no
   * caller ever learns an invoice was minted, and without this catch the orphan
   * was silent (issue 2370). Raised here, for EVERY caller; the callers' own catch
   * covers only the later COMMIT failure, and cannot double-alert this case
   * because they arm it only after we resolve. The helper logs synchronously and
   * dispatches the Telegram page without awaiting it, so this aborted
   * transaction's connection is not held for the POST (issue 2379).
   */
  static async recordProviderPayment(
    providerName: string,
    request: CreatePaymentRequest,
    response: PaymentResponse,
    storeId?: string
  ): Promise<void> {
    try {
      await PaymentService.recordCreatedPayment(providerName, request, response, storeId);
    } catch (err) {
      await alertOrphanedProviderInvoice({
        storeId: storeId ?? 'unknown',
        orderId: request.orderId,
        orderNumber: request.orderNumber,
        provider: providerName,
        transactionId: response.transactionId,
        amount: request.amount,
        currency: request.currency,
        source: 'record',
      });
      throw err;
    }
  }

  /** The Payment row + its `created` audit event for an accepted invoice. */
  private static async recordCreatedPayment(
    providerName: string,
    request: CreatePaymentRequest,
    response: PaymentResponse,
    storeId?: string
  ): Promise<void> {
    // Store on its Durable Object (Ruling CF-PAY-1): the payment row, its `created` event and the entity-index rows are ONE section.
    const orderStore = await PaymentService.doStoreOfOrder(storeId);
    if (orderStore) {
      await orderStore.money.paymentCreate({
        orderId: request.orderId,
        provider: providerName,
        amount: request.amount,
        currency: request.currency,
        transactionId: response.transactionId ?? null,
        invoiceId: response.invoiceId ?? null,
        paymentUrl: response.paymentUrl || null,
      });
      return;
    }
    const payment = await prisma.payment.create({
      data: {
        orderId: request.orderId,
        provider: providerName,
        method: null, // Will be set when payment is completed via webhook
        amount: request.amount,
        currency: request.currency,
        status: 'pending',
        transactionId: response.transactionId,
        invoiceId: response.invoiceId,
        // A reference-code payment (Fawry) has no URL: the instruction is in the metadata.
        paymentUrl: response.paymentUrl || null,
        metadata: {
          provider: providerName,
          invoiceId: response.invoiceId,
          paymentUrl: response.paymentUrl || null,
          ...response.metadata,
        } as Prisma.InputJsonValue,
      },
      include: { order: { select: { storeId: true } } },
    });

    // Append-only audit row — see payment-event.service.ts
    await recordPaymentEvent({
      paymentId: payment.id,
      storeId: payment.order.storeId,
      orderId: payment.orderId,
      eventType: 'created',
      toStatus: 'pending',
      provider: providerName,
      details: {
        amount: request.amount,
        currency: request.currency,
        transactionId: response.transactionId,
        invoiceId: response.invoiceId,
      },
    });
  }

  /**
   * Get payment status
   */
  static async getPaymentStatus(
    transactionId: string,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<PaymentStatusResponse> {
    // Try to find the payment in database to get the provider. A caller that already names the provider AND the store
    // (the auto-cancel sweep, for a store on its Durable Object whose payment is not in Postgres) needs no lookup.
    const payment =
      provider && storeId
        ? null
        : await prisma.payment.findFirst({
            where: { transactionId },
            include: { order: { include: { store: true } } },
          });

    const providerName = provider || (payment?.provider as PaymentProvider) || undefined;
    const effectiveStoreId = storeId || payment?.order?.storeId;
    return (await factory.getProvider(providerName, effectiveStoreId)).getPaymentStatus(
      transactionId
    );
  }

  /**
   * Get refund status — looks up a previously-submitted refund's current
   * state at the provider. Used by the manual "Refresh refund status"
   * button on the admin order detail page when the refund webhook didn't
   * arrive or the merchant wants to confirm execution.
   */
  static async getRefundStatus(
    refundId: string,
    provider: PaymentProvider,
    storeId: string
  ): Promise<import('./types').RefundStatusResponse> {
    const p = await factory.getProvider(provider, storeId);
    if (!p.getRefundStatus) {
      throw new AppError(400, 'NOT_SUPPORTED', `${provider} does not support refund status lookup`);
    }
    return p.getRefundStatus(refundId);
  }

  /**
   * Authenticate one gateway delivery and parse it. THROWS (400 MISSING_SIGNATURE /
   * INVALID_SIGNATURE / WEBHOOK_MALFORMED) when it is not genuine. The webhook route calls this
   * BEFORE it persists anything (SEC-5: a forged delivery must not write an inbox row or queue
   * an event); `handleWebhook` calls it again over the stored raw body, so the cryptographic
   * check is never skipped on the async path or on a replay.
   */
  static async verifyWebhookDelivery(
    provider: PaymentProvider,
    payload: unknown,
    signature?: string,
    storeId?: string,
    rawBody?: string
  ): Promise<WebhookPayload> {
    const p = await factory.getProvider(provider, storeId);
    // Owner decision 2026-10-01 (issue 2065, ruling RL-2a): a webhook is SAVED
    // first (the durable inbox row, replayable from /webhook-events) but is
    // NEVER acted on until its signature verifies. This used to be
    // `if (signature) { verify }` — fail-OPEN: a call with no signature (an
    // inbox row stored with an empty one, a replay, any future caller) skipped
    // verification and went straight on to move money. No signature is now a
    // rejection, exactly like a wrong one.
    if (!signature) {
      throw new AppError(400, 'MISSING_SIGNATURE', 'Webhook signature is required');
    }
    let webhookData: WebhookPayload;
    {
      // Verify against the raw body string when available (required for a
      // correct HMAC). Fall back to the payload object for providers that do
      // not use raw-body HMAC.
      const verifyTarget: unknown = rawBody !== undefined ? rawBody : payload;
      let verified: WebhookPayload | null = null;
      let signatureOk: boolean;
      if (p.verifyAndParseWebhook) {
        // v2 adapter (Paymob / Kashier / Fawry): verify and parse in one step, over the raw
        // body when we have it (the three gateways sign parsed fields, so a re-serialised
        // payload verifies the same).
        try {
          verified = p.verifyAndParseWebhook(
            typeof verifyTarget === 'string' ? verifyTarget : JSON.stringify(verifyTarget),
            signature
          );
          signatureOk = true;
        } catch (verifyError) {
          if (
            verifyError instanceof PaymentProviderError &&
            verifyError.code === 'WEBHOOK_MALFORMED'
          ) {
            throw new AppError(400, 'WEBHOOK_MALFORMED', 'Webhook body is not a valid delivery');
          }
          signatureOk = false;
        }
      } else {
        signatureOk = p.verifyWebhook(verifyTarget, signature);
      }
      if (!signatureOk) {
        // HMAC verification failed — could be a single misconfigured test
        // webhook (noise) or a real attacker / rotated credential (signal).
        // Throttle via redis counter: 3+ failures from the same provider
        // + store in 5 minutes = real, fire a P0 alert. Single fails just
        // throw without alerting.
        try {
          const counterKey = `payment-hmac-fail:${provider}:${storeId ?? 'platform'}`;
          const count = await redis.incrementRateLimit(counterKey, 300);
          if (count >= 3) {
            void sendAlert({
              level: 'p0',
              scope: storeId ? 'store' : 'platform',
              ...(storeId
                ? {
                    store: {
                      id: storeId,
                      name:
                        (
                          await withStore(storeId, tx =>
                            tx.store.findUnique({
                              where: { id: storeId },
                              select: { name: true },
                            })
                          )
                        )?.name ?? storeId,
                    },
                  }
                : {}),
              source: 'payment.webhook.hmac_fail',
              title: 'payment.webhook.hmac_fail',
              body: `Payment webhook signature failures for store ${storeId}: ${provider} failed ${count} times in 5 min. Likely a rotated or wrong webhook secret (genuine deliveries are answered 401 and the gateway retries them) or an attacker.`,
              context: { provider, storeId, failureCount: count },
            }).catch(() => undefined);
          }
        } catch {
          // Never let alert bookkeeping break the actual security check —
          // the throw below is the load-bearing action.
        }
        throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature');
      }
      // Parse webhook using the structured payload object (v2: parsed with the verification).
      webhookData = verified ?? p.parseWebhook(payload);
    }
    return webhookData;
  }

  /**
   * Process refund
   *
   * TRANSACTION BOUNDARIES. Every write this method makes about the money —
   * the claim before the provider call, the release or the indeterminate mark
   * after a failure, the confirmation after success — COMMITS ON ITS OWN, in a
   * transaction opened here (`commitOnOwnTransaction`), never on the caller's.
   *
   * Both HTTP callers (`POST /returns/admin/:id/complete`, the order page's
   * `refund-via-provider`) run inside the request's tenant transaction, which
   * commits only when the response is < 500. The provider call is not part of
   * that transaction and cannot be rolled back, so a record of it that lives
   * there is lost exactly when it matters: any 5xx after the refund went out
   * (an Inngest enqueue blip in the fanout, a failed completion write) rolled
   * back the claim, the status flip and the refund id together, leaving money
   * at the customer and a payment that still read as refundable — the retry
   * refunded again. Committing each step separately keeps the record of every
   * refund that may have left, whatever happens to the request afterwards.
   *
   * It also removes a hang. The post-provider write used to be an array
   * transaction on the client, which is not routed to the ambient tenant
   * transaction (see tests/unit/nested-transaction-registry.test.ts): it
   * opened a second connection that waited on the row lock the claim held in
   * the first, while the first waited on it. Nothing in Postgres sees that
   * cycle, so every gateway refund inside a request stalled until the request
   * transaction timed out at 30s — rolling back the claim — and then committed
   * the status flip with the old balance. Measured on Postgres 17 before this
   * change: 30,006 ms, then P2028.
   */
  static async refund(
    request: RefundRequest,
    provider?: PaymentProvider,
    storeId?: string
  ): Promise<RefundResponse & { wholeOrderEffectsApplied: boolean }> {
    // Find payment to get provider
    // Refuse an absent transaction id BEFORE the lookup. Prisma drops
    // `undefined` filters, so `where: { transactionId: undefined }` is an EMPTY
    // where — findFirst then returns an arbitrary payment row and every step
    // below operates on the wrong order: the claim writes its status and
    // refundedAmount, the transition guard runs against its order, and a
    // successful provider call flips THAT order to refunded, restores its
    // inventory, reverses its GL and emails "Refund issued" to a customer who
    // returned nothing.
    //
    // A null transaction id is not exotic here: COD payments are created
    // without one and the mark-COD-paid route flips them to 'completed'
    // without ever setting one, and COD is the dominant method in this market.
    // The order-level refund routes already guard this; centralising it means
    // no future caller can reintroduce it.
    if (!request.transactionId) {
      throw new AppError(
        400,
        'PAYMENT_NOT_REFUNDABLE',
        'This payment has no provider transaction and cannot be refunded at the gateway. Use a manual refund method.'
      );
    }

    // transactionId is not unique (issue 769 / Ruling AMS-2): a collision
    // must never pick an arbitrary row to refund. Read two; refuse on more.
    if (storeId) {
      const money = await storeMoney(storeId);
      if (money) return PaymentService.refundOnDo(money, request, provider, storeId);
    }
    const refundMatches = await prisma.payment.findMany({
      where: { transactionId: request.transactionId },
      include: { order: { include: { store: true } } },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    if (refundMatches.length > 1) {
      logger.error(
        { transactionId: request.transactionId, paymentIds: refundMatches.map(m => m.id) },
        '[PAYMENT] refund transaction id matches more than one payment — refusing to guess'
      );
      throw new AppError(
        409,
        'AMBIGUOUS_PAYMENT',
        'This transaction id matches more than one payment. Refund it from the provider dashboard and contact support.'
      );
    }
    const payment = refundMatches[0];

    if (!payment) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    // InstaPay has no provider to refund through: the merchant sends the money back
    // from their own InstaPay app and records it with a manual refund.
    if (payment.provider === 'instapay') {
      throw new AppError(
        409,
        'MANUAL_PROVIDER_REFUND',
        'InstaPay payments are refunded by the merchant outside the system. Use a manual refund.'
      );
    }

    // `amount: 0` is a CALLER BUG, never "refund the whole payment".
    // `Return.refundAmount` is `Int @default(0)` and NOT NULL, so
    // `returnRequest.refundAmount ?? undefined` yields 0 — and the old
    // `!request.amount` predicate turned every partial return whose amount was
    // never entered into a FULL provider refund plus a whole-order
    // `order/refunded`, reversing the entire sale journal and erasing the
    // revenue, tax and COGS for the items the customer kept. Only an ABSENT
    // amount may mean "the whole payment"; a zero or negative one is rejected
    // loudly before any money moves.
    if (request.amount != null && request.amount <= 0) {
      throw new AppError(
        400,
        'INVALID_REFUND_AMOUNT',
        'Refund amount must be greater than zero. Omit it to refund the full payment.'
      );
    }

    // Budget against what is LEFT on the payment, not its original amount: a
    // prior partial refund already sent part of it back, and `refundedAmount`
    // records how much. Measuring "full" against `payment.amount` would let a
    // second refund exceed the balance, and would read the remainder of an
    // already-partially-refunded payment as a partial refund (skipping the
    // whole-order fanout that a genuinely exhausting refund owes).
    const alreadyRefunded = payment.refundedAmount ?? 0;
    const refundableRemaining = payment.amount - alreadyRefunded;
    if (refundableRemaining <= 0) {
      throw new AppError(
        400,
        'ALREADY_REFUNDED',
        'This payment has already been refunded in full.'
      );
    }
    if (request.amount != null && request.amount > refundableRemaining) {
      throw new AppError(
        400,
        'REFUND_EXCEEDS_REMAINING',
        'Refund amount exceeds the un-refunded balance of this payment.'
      );
    }
    const amountToRefund = request.amount ?? refundableRemaining;
    // Does this refund use up the payment? That decides the PAYMENT's status.
    const isFullRefund = amountToRefund >= refundableRemaining;
    // Does it reverse the ORDER? Not the same question (#1402). Payment
    // exhaustion only means the money is gone; `refund-via-provider` and the
    // settle webhook raise `refundedAmount` without any Return row, so a
    // partial return's allocation can equal what is left while lines the
    // customer kept are still on the order. A caller that applies item-level
    // effects itself says so, and then the order stays as it is.
    const flipsOrder = isFullRefund && !request.itemLevel;

    // Reject a stale/invalid order state BEFORE any money moves. A full
    // refund flips `Order.status` to 'refunded' below (bypassing
    // `updateStatus`) — guard it with the same state machine so a refund
    // request against an order some OTHER path already moved to a terminal
    // state (e.g. `cancelled`) can't silently regress it. Deliberately
    // checked here, before the payment claim and the provider call, not at
    // the DB-write site further down — an invalid transition must never
    // reach the gateway (money-integrity: no undo API for a real refund).
    if (flipsOrder && payment.order) {
      assertValidTransition(payment.order.status, 'refunded');
    }

    // The payment's own store, not the caller's: RLS for the separately
    // committed writes below must scope to the row being written.
    const moneyStoreId = payment.order?.storeId ?? storeId;
    const claimId = crypto.randomUUID();
    const refundEvent = (
      eventType: string,
      reason: string,
      extra: Record<string, unknown> = {}
    ): Prisma.PaymentEventUncheckedCreateInput => ({
      paymentId: payment.id,
      storeId: moneyStoreId ?? '',
      orderId: payment.orderId,
      eventType,
      provider: payment.provider,
      details: {
        reason,
        claimId,
        amount: amountToRefund,
        refundKey: request.refundKey ?? null,
        ...extra,
      } as Prisma.InputJsonValue,
    });

    // Atomically CLAIM the payment before touching the provider. A plain
    // `status === 'completed'` read-check is a TOCTOU race: two concurrent
    // refund requests (admin double-click, client retry, two staff on one
    // order) both read 'completed', both pass, and both call provider.refund()
    // — a double refund at the gateway with no undo API = real money lost.
    // We flip the refundable status -> the terminal refund status in one atomic
    // updateMany; only the request whose update matches (count === 1) proceeds.
    // (PaymentStatus is a Prisma enum with no transient 'refunding' value, so
    // we claim with the final status and revert to the pre-claim one if the
    // provider call throws — avoids an enum migration.)
    //
    // 'partially_refunded' is a legitimate STARTING state — a payment can be
    // refunded piece by piece (two partial returns on one order), so the claim
    // must accept it. But 'partially_refunded' -> 'partially_refunded' is not a
    // state CHANGE, so the status flip alone stops being a mutex there. The
    // guard is therefore a compare-and-swap on `refundedAmount`: we match the
    // balance we read and write the post-refund one in the same statement, so
    // of two concurrent requests only the one that still sees the old balance
    // matches. (This is also why the increment moved out of the post-provider
    // transaction below — it IS the claim now.)
    //
    // The claim is recorded as a `refund_initiated` payment event in the SAME
    // committed transaction (#1317). A process that dies between this commit
    // and the provider's answer leaves a balance raised by money that may
    // never have moved; the event is what lets the stuck-claim sweep find it
    // and an operator see it on the order page, instead of a column value
    // indistinguishable from a real refund.
    const claimedStatus = isFullRefund ? 'refunded' : 'partially_refunded';
    await commitOnOwnTransaction(moneyStoreId, async () => {
      const claim = await prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: ['completed', 'partially_refunded'] },
          refundedAmount: alreadyRefunded,
        },
        data: { status: claimedStatus, refundedAmount: alreadyRefunded + amountToRefund },
      });
      if (claim.count === 0) {
        throw new AppError(
          400,
          'INVALID_STATE',
          'Payment is not refundable or a refund is already in progress'
        );
      }
      // One refund per business event. The caller's own mutex (the Return's
      // completion claim) lives in the request transaction, so it is released
      // by the very rollback that follows a failure AFTER the money left —
      // leaving the return retryable while the refund stands. This check is
      // committed state, so the retry is refused here instead of paying again.
      // Evaluated after the CAS so the payment row lock serialises two claims
      // for the same key.
      if (request.refundKey) {
        const outstanding = await findOutstandingRefundClaims(
          payment.id,
          request.refundKey,
          moneyStoreId
        );
        if (outstanding.length > 0) {
          throw new AppError(
            409,
            'REFUND_ALREADY_ISSUED',
            'A refund for this was already sent to the payment provider and may have gone through. Check the provider dashboard before refunding again.',
            { refundKey: request.refundKey }
          );
        }
      }
      await prisma.paymentEvent.create({
        data: {
          ...refundEvent(REFUND_CLAIM_EVENT, 'refund_claimed', {
            // read back by the settlement rules (Fawry kind match, release status): same shape as the StoreDO claim
            isFullRefund,
            flipsOrder,
            priorStatus: payment.status,
          }),
          fromStatus: payment.status,
          toStatus: claimedStatus,
        },
      });
    });

    // Undo the claim — ONLY for a failure that proves nothing was sent. A
    // decrement rather than a compare-and-swap back to the old balance: the
    // claim is committed now, so another refund on the same payment may have
    // raised the balance past ours in the meantime, and a CAS on our old value
    // would silently fail to release anything.
    const releaseClaim = async (reason: string, err: unknown) => {
      try {
        // ONE function decides under the payment lock: released, or (a webhook already absorbed the claim) flagged for review
        const outcome = await commitOnOwnTransaction(moneyStoreId, () =>
          settleClaimRelease({
            paymentId: payment.id,
            storeId: moneyStoreId as string,
            orderId: payment.orderId,
            claimId,
            amount: amountToRefund,
            claimedStatus,
            priorStatus: payment.status as string,
            provider: payment.provider ?? null,
            reason,
            error: err instanceof Error ? err.message : String(err),
          })
        );
        if (outcome === 'review')
          logger.error(
            { paymentId: payment.id, claimId },
            '[PAYMENT] refund claim NOT released: a webhook already reported this refund completed — review with the provider'
          );
      } catch (releaseError) {
        // The claim stays on the row and stays OUTSTANDING in the event log,
        // so the stuck-claim sweep reports it rather than it vanishing.
        logger.error(
          { err: releaseError, paymentId: payment.id, claimId },
          '[PAYMENT] failed to release refund claim after a refund that was not sent — balance overstated, manual reconciliation required'
        );
      }
    };

    const providerName = provider || (payment.provider as PaymentProvider);
    const effectiveStoreId = storeId || payment.order?.storeId;
    // Resolving the provider is not a provider call: a failure here sent nothing.
    let providerImpl: IPaymentProvider;
    try {
      providerImpl = await factory.getProvider(providerName, effectiveStoreId);
    } catch (resolveError) {
      await releaseClaim('provider_unavailable', resolveError);
      throw resolveError;
    }

    let response: RefundResponse;
    try {
      // An ABSENT amount means "the whole payment" to every provider, so it
      // would send the ORIGINAL amount back — paying the already-refunded
      // portion a second time. Once anything has been refunded, spell the
      // remaining balance out. Only the provider's own fields are passed on.
      response = await providerImpl.refund({
        transactionId: request.transactionId,
        reason: request.reason,
        amount:
          request.amount == null && alreadyRefunded > 0 ? refundableRemaining : request.amount,
      });
    } catch (providerError) {
      if (providerError instanceof ProviderRejectedError) {
        // The provider answered and refused, or the request was never sent:
        // no money moved. Release the claim so the admin can legitimately retry.
        await releaseClaim('provider_rejected', providerError);
        throw providerError;
      }
      // A timeout, a dropped connection, a 5xx: the refund may have executed
      // (#1359). Releasing here is how a timeout became a second real refund —
      // the balance was reset, the caller's "did the balance move?" probe read
      // no, and the merchant was told to retry. Keep the claim: the balance
      // then errs toward "refunded", which blocks a second refund instead of
      // funding one, and the event marks it for reconciliation.
      await commitOnOwnTransaction(moneyStoreId, async () => {
        await prisma.paymentEvent.create({
          data: refundEvent(REFUND_INDETERMINATE_EVENT, 'provider_no_clear_answer', {
            error: providerError instanceof Error ? providerError.message : String(providerError),
          }),
        });
      }).catch(eventError =>
        logger.error(
          { err: eventError, paymentId: payment.id, claimId },
          '[PAYMENT] failed to record an indeterminate refund — the claim stands, reconcile manually'
        )
      );
      logger.error(
        { err: providerError, paymentId: payment.id, claimId, amount: amountToRefund },
        '[PAYMENT] provider gave no clear answer to a refund — claim KEPT, outcome unknown, reconcile with the provider'
      );
      throw markRefundMayHaveExecuted(
        new AppError(
          502,
          'PROVIDER_REFUND_INDETERMINATE',
          'The payment provider did not confirm the refund (timeout or server error), so it may have gone through. It is recorded as pending reconciliation — check the provider dashboard before refunding again.'
        )
      );
    }

    // Record the executed refund. The claim above already applied the
    // balance and the payment status, so this adds the refund id and — for a
    // refund that reverses the order — the order flip. It does NOT rewrite the
    // status: the claim is committed, so a later claim on the same payment
    // may already have moved it on, and writing ours back would regress it.
    // Refunds are terminal at the provider (no undo API); if this write fails,
    // log loudly with the refund id so finance can reconcile, and tell the
    // caller the money moved.
    try {
      await commitOnOwnTransaction(moneyStoreId, async () => {
        // Under the payment LOCK, from the LOCKED row: a webhook that committed meanwhile (its id, its status map) must not be
        // overwritten by a stale spread, or its redelivery would be booked a second time.
        const locked = await lockPayment(payment.id);
        const currentMetadata = locked?.metadata ?? payment.metadata;
        // A settle webhook already ABSORBED this claim under a different refund id than the one the provider just answered
        // with: two refunds were reconciled as one. Nothing is overwritten; a human reviews it.
        const absorbedAs = await absorbedRefundIdFor(payment.id, moneyStoreId ?? '', claimId);
        if (absorbedAs && absorbedAs !== response.refundId) {
          await prisma.paymentEvent.create({
            data: {
              ...refundEvent(REFUND_REVIEW_EVENT, 'absorbed_under_a_different_refund_id', {
                absorbedRefundId: absorbedAs,
                answeredRefundId: response.refundId,
              }),
              fromStatus: claimedStatus,
            },
          });
          void alertUnbookedRefund({
            kind: 'absorbed_id_mismatch',
            store: {
              id: moneyStoreId ?? '',
              name: payment.order?.store?.name ?? moneyStoreId ?? '',
            },
            orderRef: payment.order?.orderNumber ?? payment.orderId,
            body: `Order ${payment.order?.orderNumber ?? payment.orderId}: a refund webhook (${absorbedAs}) was reconciled with our refund, but the provider answered our refund with ${response.refundId}. They may be two refunds counted as one: check the provider dashboard.`,
            context: { paymentId: payment.id, claimId, absorbedAs, answeredAs: response.refundId },
          }).catch(() => undefined);
        }
        // The answered id was ALREADY filed as accounted (a webhook with this id was absorbed by ANOTHER same-amount claim):
        // this claim would stay open forever and hold every later Kashier refund. Close it on that evidence, audited.
        if (
          !absorbedAs &&
          readAccountedRefundEventIds(currentMetadata).includes(response.refundId)
        ) {
          await prisma.paymentEvent.create({
            data: {
              ...refundEvent(REFUND_ABSORBED_EVENT, 'id_match_reassigned', {
                refundId: response.refundId,
                via: 'id_match_reassigned',
              }),
              fromStatus: claimedStatus,
            },
          });
        }
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            refundId: response.refundId,
            // NO `refundedAmount` write here — the atomic claim above already
            // applied it, and re-incrementing would double-count the balance
            // and let a later refund overshoot the payment.
            metadata: {
              ...((currentMetadata as object) || {}),
              refundId: response.refundId,
              // The atomic claim above already added this refund's amount to
              // `refundedAmount`, so record its id: the provider's async settle
              // webhook for the SAME refund must not add it a second time.
              [REFUND_EVENT_IDS_KEY]: appendRefundEventId(currentMetadata, response.refundId),
              // …and seed the per-refund status map in the same write (#1487),
              // from the same freshly re-read metadata. Left empty,
              // isRefundEventAlreadySeen falls back to the payment-wide
              // scalar, which drops the NEXT refund's webhook unread once any
              // refund settled.
              [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
                currentMetadata,
                response.refundId,
                response.status
              ),
              refundStatus: response.status,
              refundReason: request.reason ?? null,
              refundedAt: new Date().toISOString(),
            },
          },
        });
        if (flipsOrder) {
          await prisma.order.update({
            where: { id: payment.orderId, storeId: moneyStoreId },
            data: { status: 'refunded', paymentStatus: 'refunded' },
          });
        }
        await prisma.paymentEvent.create({
          data: {
            ...refundEvent(REFUND_EXECUTED_EVENT, 'refund_sent', {
              refundId: response.refundId,
              providerStatus: response.status,
            }),
            toStatus: claimedStatus,
          },
        });
      });
      // Bust the admin aggregated-customers snapshot on a paymentStatus
      // transition — this changes the paid/refunded counts it aggregates.
      if (effectiveStoreId) await invalidateCustomersCache(effectiveStoreId);
    } catch (txError) {
      logger.error(
        {
          err: txError,
          paymentId: payment.id,
          orderId: payment.orderId,
          refundId: response.refundId,
          refundAmount: amountToRefund,
          isFullRefund,
        },
        '[PAYMENT] DB transaction failed AFTER provider refund succeeded — manual reconciliation required (refund already executed at provider, cannot undo)'
      );
      throw markRefundMayHaveExecuted(txError);
    }

    // A partial refund that no item-level flow books — the order page's
    // refund-via-provider with an amount, never a return (those always pass a
    // refundKey). Owner decision 2026-10-01 (#1209): booked as a revenue
    // refund for exactly this amount, no stock movement, keyed on the
    // provider's refund id so its later settle webhook books nothing more.
    // Sent NOW rather than after the caller's request commits: the refund
    // record above is already committed on its own transaction, so a later
    // rollback of the request must not drop the ledger entry of a refund that
    // stands. A failed send is raised for a human instead of failing the
    // caller — the money has moved either way.
    if (
      !flipsOrder &&
      !request.refundKey &&
      moneyStoreId &&
      payment.orderId &&
      !response.refundId
    ) {
      // Issue 2310: never invent a GL key the provider will not repeat. The
      // old `claim-<claimId>` fallback booked this refund under one key and
      // its settle webhook (carrying the provider's REAL id) under another,
      // so one refund booked twice. With no provider id there is nothing
      // both paths share: book nothing here, and page a human.
      const orderRef = payment.order?.orderNumber ?? payment.orderId;
      await alertUnbookedRefund({
        kind: 'partial_no_gl',
        store: { id: moneyStoreId, name: payment.order?.store?.name ?? moneyStoreId },
        orderRef,
        body: `Order ${orderRef}: a partial refund of ${amountToRefund} piastres was sent to the provider outside a return, but the provider returned no refund id, so it was NOT booked here (a made-up key would double-book it when the provider's settle notice arrives). Check the provider dashboard; if no settle notice books it, book it by hand.`,
        context: { paymentId: payment.id, orderId: payment.orderId, claimId },
      });
    } else if (!flipsOrder && !request.refundKey && moneyStoreId && payment.orderId) {
      const providerRefundId = response.refundId as string;
      try {
        await OrderService.recordRefundOutsideReturn(
          moneyStoreId,
          payment.orderId,
          { providerRefundId, amount: amountToRefund },
          { sendNow: true }
        );
      } catch (sendError) {
        logger.error(
          { err: sendError, paymentId: payment.id, orderId: payment.orderId, providerRefundId },
          '[PAYMENT] partial refund outside a return: order/refunded not sent — the GL entry is missing'
        );
        const orderRef = payment.order?.orderNumber ?? payment.orderId;
        await alertUnbookedRefund({
          kind: 'partial_no_gl',
          store: { id: moneyStoreId, name: payment.order?.store?.name ?? moneyStoreId },
          orderRef,
          body: `Order ${orderRef}: a partial refund of ${amountToRefund} piastres was sent to the provider outside a return, but its ledger event could not be queued — nothing books it: book it by hand.`,
          context: { paymentId: payment.id, orderId: payment.orderId, refundId: response.refundId },
        });
      }
    }

    // Refund effects: inventory restore, coupon usage decrement, affiliate
    // commission reversal. Only for full refunds — partial refunds keep
    // the inventory deducted and the commission earned, since the
    // customer kept (most of) the items. Idempotent at the OrderService
    // level so a same-order full-refund-after-partial-refund won't
    // double-up the restore.
    if (flipsOrder) {
      const order = await prisma.order.findUnique({
        where: { id: payment.orderId, storeId: moneyStoreId },
        select: { storeId: true },
      });
      if (order) {
        // Let a failure here PROPAGATE. `applyRefundEffects` is now a thin
        // dispatcher (`inngest.send('order/refunded', ...)`) — it's the
        // ONLY signal that fires inventory restore, coupon/affiliate/
        // loyalty reversal, and the customer refund email/admin push. The
        // provider money movement + Payment/Order status flip above are
        // already committed and are NOT undone by this failing — but
        // silently swallowing it here (as this used to, back when
        // applyRefundEffects did heavy inline work and this really was
        // non-fatal reconciliation debt) would drop that fanout with zero
        // signal to the caller, leaving the admin `refund-via-provider`
        // route free to report HTTP 200 for a refund whose reversal chain
        // never ran (money-integrity audit F2). The caller must see this.
        //
        // And it is recoverable (#766): the order flip committed on its own
        // above, so refund-reversal-stuck-sweep finds a `refunded` order with
        // no `refundReversedAt` and re-sends the event.
        try {
          await OrderService.applyRefundEffects(order.storeId, payment.orderId);
        } catch (effectsError) {
          throw markRefundMayHaveExecuted(effectsError);
        }
      }
    }

    return { ...response, wholeOrderEffectsApplied: flipsOrder };
  }

  /**
   * Handle webhook
   */
  static async handleWebhook(
    provider: PaymentProvider,
    payload: unknown,
    signature?: string,
    storeId?: string,
    rawBody?: string
  ): Promise<{ success: boolean; status?: string; orderId?: string }> {
    const p = await factory.getProvider(provider, storeId);

    let webhookData = await PaymentService.verifyWebhookDelivery(
      provider,
      payload,
      signature,
      storeId,
      rawBody
    );

    // Store on its Durable Object (Ruling CF-PAY-1): lookup, confirm-before-apply, the state claims and the audit rows are
    // ONE section there; the Worker only does the gateway confirmation and the post-commit work.
    if (storeId) {
      const money = await storeMoney(storeId);
      if (money) return PaymentService.handleWebhookOnDo(money, p, provider, webhookData, storeId);
    }

    // Find and update payment. Include `order.customer` + `order.store` so we
    // can render the customer's name and store name in the post-status
    // notifications fired below — order.service.ts deferred those for online-
    // payment orders so they fire ONCE, AFTER the webhook confirms the
    // payment outcome (success or failure), not at order-creation time.
    //
    // Defense-in-depth: when storeId was resolved upfront by the route
    // handler, scope the Payment lookup to that store. Provider-generated
    // transaction IDs are globally unique in practice (separate merchant
    // accounts per provider), but adding the storeId predicate means a
    // payload that arrived with a forged/recycled transaction ID can never
    // resolve to a different merchant's order than the one that owned the
    // HMAC secret we just verified against.
    //
    // transactionId / invoiceId carry NO unique constraint (issue 769 — adding
    // one needs a production duplicate check first, see Ruling AMS-2), so a
    // bare findFirst could bind a colliding id to an arbitrary row, including
    // another tenant's when no storeId was resolved. Read up to two: more than
    // one match is refused loudly (it lands in the webhook inbox for a human)
    // instead of processing whichever row Postgres returned first.
    const paymentMatches = await prisma.payment.findMany({
      where: {
        AND: [
          {
            // Only the references the webhook actually carries: Prisma drops an `undefined`
            // filter, and `{ invoiceId: undefined }` inside an OR would match EVERY payment.
            OR: [
              ...(webhookData.transactionId ? [{ transactionId: webhookData.transactionId }] : []),
              ...(webhookData.invoiceId ? [{ invoiceId: webhookData.invoiceId }] : []),
              ...(!webhookData.transactionId && !webhookData.invoiceId
                ? [{ id: '00000000-0000-0000-0000-000000000000' }]
                : []),
            ],
          },
          ...(storeId ? [{ order: { storeId } }] : []),
        ],
      },
      include: {
        order: {
          include: {
            customer: true,
            store: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    if (paymentMatches.length > 1) {
      logger.error(
        {
          provider,
          storeId,
          transactionId: webhookData.transactionId,
          invoiceId: webhookData.invoiceId,
          paymentIds: paymentMatches.map(m => m.id),
        },
        '[PAYMENT WEBHOOK] provider ids match more than one payment — refusing to guess which one'
      );
      // LOUD, not just logged: this is a real provider event (the signature
      // already verified) that nothing will apply — a captured payment whose
      // order may never flip to paid. P0 per incident (the ids are in the
      // title, so a second collision is not throttled into the first). The
      // webhook processor also exempts this code from its terminal-4xx lane,
      // so it retries and dead-letters into the existing P0 path.
      const firstStoreId = paymentMatches[0]?.order?.storeId;
      await sendAlert({
        level: 'p0',
        scope: storeId ? 'store' : 'platform',
        ...(storeId
          ? {
              store: {
                id: storeId,
                name: paymentMatches[0]?.order?.store?.name ?? storeId,
              },
            }
          : {}),
        source: 'payment.webhook.ambiguous_payment',
        title: `Webhook id matches ${paymentMatches.length}+ payments — ${provider} ${webhookData.transactionId ?? webhookData.invoiceId ?? ''}`,
        body:
          `A verified ${provider} webhook names a transaction/invoice id that matches more than one payment, ` +
          `so it was NOT applied. The customer may have paid for an order that still reads unpaid. ` +
          `Find the right payment in the provider dashboard and replay the event from /webhook-events.`,
        context: {
          provider,
          storeId: storeId ?? firstStoreId ?? null,
          transactionId: webhookData.transactionId,
          invoiceId: webhookData.invoiceId ?? null,
          paymentIds: paymentMatches.map(m => m.id),
        },
      }).catch(() => undefined);
      throw new AppError(
        409,
        'AMBIGUOUS_PAYMENT',
        'Webhook transaction/invoice id matches more than one payment'
      );
    }
    const payment = paymentMatches[0] ?? null;

    if (!payment) {
      logger.error(
        { transactionId: webhookData.transactionId, storeId },
        '[PAYMENT WEBHOOK] Payment not found (or storeId mismatch — defense-in-depth scope rejected lookup)'
      );
      return { success: true, orderId: undefined }; // Acknowledge webhook even if payment not found
    }

    // Belt-and-braces: even after the scoped lookup, assert the linked
    // order's storeId matches the resolved storeId. Catches the (extremely
    // unlikely) case where storeId resolution differed from payment.order
    // by some bug in the resolver function.
    if (storeId && payment.order && payment.order.storeId !== storeId) {
      logger.error(
        {
          transactionId: webhookData.transactionId,
          resolvedStoreId: storeId,
          paymentStoreId: payment.order.storeId,
        },
        '[PAYMENT WEBHOOK] storeId mismatch between resolver and payment.order — refusing to process'
      );
      throw new AppError(400, 'STORE_MISMATCH', 'Webhook payload does not match resolved store');
    }

    // Confirm-before-apply (Ruling PROVIDERS-17). A gateway whose signature leaves a
    // money-deciding field unsigned (Kashier: `event`, refund vs payment) is asked
    // server-to-server what this transaction really is, and ONLY that answer is applied below.
    // No answer = nothing applied: the error is a 5xx, so the webhook queue retries it and,
    // once retries are spent, dead-letters it into the P0 path with the inbox row replayable.
    if (p.confirmWebhook) {
      webhookData = await confirmBeforeApply(p, webhookData, {
        provider,
        paymentId: payment.id,
        paymentStatus: payment.status,
        orderId: payment.orderId,
        storeId: payment.order?.storeId ?? storeId ?? '',
      });
    }

    // Refund webhook short-circuit. A gateway delivers a refund event when it
    // executes or rejects a previously-submitted refund. The adapter tags these with the
    // `refund` field. Route them through a separate path so we don't
    // re-mutate the order's payment lifecycle every time a refund updates.
    if (webhookData.refund) {
      const refundEvent = webhookData.refund;
      // The whole refund branch (lock, decide, effects, write) is ONE transaction holding the payment row lock.
      return await inSettlementTx(payment.order?.storeId ?? storeId ?? '', async () => {
        // ONE function settles a refund event against the payment: it takes the payment row lock, re-reads the payment and its
        // refund events, decides (absorb only a COMPLETED event; Kashier/Fawry hold rules) and returns the decision. The
        // effects below run under that lock; `settle.commit` writes the payment patch and the consumed claim atomically.
        const settle = await settleRefundEvent({
          paymentId: payment.id,
          storeId: payment.order?.storeId ?? storeId ?? '',
          orderId: payment.orderId,
          provider,
          refund: {
            refundId: refundEvent.refundId,
            status: refundEvent.status,
            amount: refundEvent.amount ?? null,
            reference: refundEvent.refundReference ?? null,
          },
        });
        payment.refundedAmount = settle.payment.refundedAmount;
        payment.metadata = settle.payment.metadata as typeof payment.metadata;
        payment.status = settle.payment.status as typeof payment.status;
        const prevMeta = settle.payment.metadata;
        const newStatus = refundEvent.status;

        // Idempotent — a REDELIVERY of this same refund at this same state is a no-op (decided under the lock).
        if (settle.seen) {
          logger.info(
            {
              paymentId: payment.id,
              orderId: payment.orderId,
              refundId: refundEvent.refundId,
              status: newStatus,
            },
            '[PAYMENT WEBHOOK] refund event matches stored status — no-op'
          );
          return { success: true, status: newStatus, orderId: payment.orderId };
        }

        // Out-of-band refund detection: if Payment.status was not already
        // 'refunded' / 'partially_refunded' when the executed webhook arrived,
        // the admin Refund-via-provider button never ran — someone refunded
        // directly in the gateway's portal. Fire applyRefundEffects so the
        // side-effects (inventory restore, coupon decrement, loyalty reversal,
        // customer email) still happen. When the admin button DID run, we
        // skip — the side-effects fired the moment they clicked.
        //
        // WRITE ORDERING (adversarial audit P2, closes 07-15 audit F3 for
        // real): the reversal dispatch + order flip run BEFORE the durable
        // `metadata.refundStatus` write below. That metadata field is this
        // branch's idempotency key — writing it first meant a failed
        // `applyRefundEffects` (Inngest event-API blip) or a rejected
        // transition left the key committed, so the Inngest retry hit the
        // `prevRefundStatus === newStatus` no-op above, the webhook was marked
        // processed, and the reversal was silently lost forever (and because
        // the order flip never ran either, refund-reversal-stuck-sweep — which
        // keys on order status — could never rescue it). With effects-first,
        // any failure leaves NO durable state, so the retry re-enters and
        // re-runs the (idempotent) reversal dispatch.
        // Has the ORDER already been reversed? The payment's own status is the
        // wrong question, and asking it cost the whole reversal chain. A payment
        // reading `partially_refunded` counted as "handled", so once a first
        // out-of-band refund left it in that state, the refund that finally
        // SETTLED the payment was written as terminal while every effect was
        // suppressed: 5000 then 4400 of a 9400-piastre payment refunded in the
        // provider's dashboard promoted the row to `refunded`, and the order sat
        // at `delivered`/`paid` with its inventory unrestored, its coupon,
        // loyalty and affiliate effects unreversed, its sale journal — revenue,
        // tax and COGS — still booked, and no refund email sent. Nothing
        // recovers it either: refund-reversal-stuck-sweep only selects orders
        // already `cancelled` or `refunded`, and the flip never ran.
        //
        // A partial refund does not reverse an order, so it must not be able to
        // stop the refund that does. The question is whether the ORDER has been
        // reversed, and the order's own status answers it.
        const orderAlreadyReversed = payment.order?.status === 'refunded';

        // How much of this payment is settled once this webhook is accounted for,
        // and whether that exhausts it. Computed ONCE, above the fanout, because
        // the whole-order side-effects and the payment status write below MUST
        // agree on it. The write records a short refund as 'partially_refunded',
        // and ReturnService explicitly accepts that status as a still-refundable
        // source. Running the whole-order fanout anyway would restore ALL
        // inventory, reverse coupon/loyalty and post the FULL GL reversal for a
        // 2000-piastre refund on a 5000-piastre payment while leaving 3000 refundable —
        // a later partial return would then execute a second real gateway refund
        // and restore the same units again, because the two paths guard on
        // different idempotency markers (order-level vs refundKey). Whole-order
        // effects belong to a whole-order refund; a partial refund's item-level
        // effects belong to the returns flow, which carries the line data this
        // webhook does not have. Same coupling order.routes.ts applies on the
        // manual refund-status refresh.
        //
        const {
          settledTotal: settledRefund,
          isFullRefund: refundIsFull,
          accountedThisEvent,
          heldUnaccountedEvent,
          heldProvenanceUnknown,
          heldOpenClaimIdUnverified,
        } = settle.decision!;

        if (newStatus === 'completed' && !orderAlreadyReversed && refundIsFull && payment.order) {
          // Reject a stale/invalid order state before running ANY reversal
          // side-effects. A provider refund executed out-of-band for an
          // order some OTHER path already moved to the terminal `refunded`
          // state must not regress it (a cancelled order CAN be refunded, PR #770) — and must not run
          // applyRefundEffects first, which would leave the reversal applied
          // but the status write rejected.
          assertValidTransition(payment.order.status, 'refunded');

          logger.info(
            { paymentId: payment.id, orderId: payment.orderId },
            '[PAYMENT WEBHOOK] out-of-band refund detected — running applyRefundEffects fresh'
          );
          // Let a genuine failure propagate. This runs inside the retriable
          // `payment-webhook-process` Inngest step, so throwing gives 3 retries +
          // the alerts-failure-watch P0 dead-letter for a money-adjacent reversal
          // (inventory/coupon/loyalty restore + refund email). Swallowing it here
          // marked the WebhookEvent 'processed' as if the reversal succeeded.
          // Safe to retry: applyRefundEffects is idempotent (per-order
          // alreadyRestoredInventory / alreadyAppliedEffects guards).
          await OrderService.applyRefundEffects(payment.order.storeId, payment.orderId);
          // Also flip the order's paymentStatus since OrderService.updateStatus
          // is not the trigger here. PROPAGATE a failure (no .catch swallow):
          // the idempotency metadata below is not yet written, so the Inngest
          // retry re-enters this branch and re-runs the (idempotent) effects +
          // this flip, instead of losing the order flip forever.
          await prisma.order.update({
            where: { id: payment.orderId, storeId: payment.order.storeId },
            data: { status: 'refunded', paymentStatus: 'refunded' },
          });
          // Bust the admin aggregated-customers snapshot — this paymentStatus
          // transition changes the paid/refunded counts it aggregates.
          await invalidateCustomersCache(payment.order.storeId);
        } else if (newStatus === 'completed' && !orderAlreadyReversed && payment.order) {
          // Partial out-of-band refund: record it on the payment below (leaving
          // the balance refundable). No order flip, no whole-order reversal —
          // see the arithmetic above. Owner decision 2026-10-01 (#1455): it is
          // booked as a revenue refund for THIS event's amount, with no stock
          // movement, keyed on the provider's refund id. Only when this event's
          // amount was actually added to the total (`accountedThisEvent`) — a
          // settle notice for a refund already counted (an in-band return or
          // order-page refund) is not a second refund. Sent BEFORE the durable
          // metadata write below, like the whole-order branch above: a failed
          // send leaves nothing written, so the webhook retry re-enters here,
          // and the GL entry is idempotent on the refund id.
          logger.info(
            {
              paymentId: payment.id,
              orderId: payment.orderId,
              refundId: refundEvent.refundId,
              settledFils: settledRefund,
              paymentAmountFils: payment.amount,
            },
            '[PAYMENT WEBHOOK] partial out-of-band refund — recording the balance and booking it as a revenue refund, skipping whole-order effects'
          );
          const accountedAmount = settledRefund - (payment.refundedAmount ?? 0);
          if (accountedThisEvent && accountedAmount > 0) {
            await OrderService.recordRefundOutsideReturn(payment.order.storeId, payment.orderId, {
              providerRefundId: refundEvent.refundId,
              amount: accountedAmount,
            });
          }
        }

        // Durable idempotency write LAST — only after the reversal side-effects
        // above have succeeded (or were legitimately skipped). Done in one
        // update so prevMeta + new fields land atomically.
        await settle.commit({
          data: {
            metadata: {
              ...prevMeta,
              refundId: refundEvent.refundId,
              // Appended only when this event's amount landed in `refundedAmount`
              // below; recording it otherwise would make a later, genuine refund
              // carrying the same id look already-counted.
              // Recorded only when this event's amount actually went into the
              // total. The settlement rule holds rather than raises when it
              // cannot establish the event is new, and an id filed against an
              // amount that was held would make the real refund carrying it look
              // already counted — so it would never be added at all.
              ...(accountedThisEvent
                ? {
                    [REFUND_EVENT_IDS_KEY]: appendRefundEventId(
                      payment.metadata,
                      refundEvent.refundId
                    ),
                  }
                : {}),
              refundStatus: newStatus,
              // Per-refund, so the next refund's webhook is not mistaken for a
              // redelivery of this one.
              [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
                payment.metadata,
                refundEvent.refundId,
                newStatus
              ),
              refundReference:
                refundEvent.refundReference ??
                (prevMeta.refundReference as string | undefined) ??
                null,
              refundStatusUpdatedAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
            // `refundedAmount` is the CUMULATIVE refund budget that
            // PaymentService.refund compare-and-swaps against, and `status`
            // gates whether ReturnService will accept the payment at all. This
            // branch used to write both absolutely — `refundedAmount` set to
            // THIS refund's amount (the provider reports one refund, not a
            // running total) and `status` forced to 'refunded' whenever it was
            // not already. On a partially-refunded payment that erased the
            // record of every earlier refund and marked the whole payment
            // settled, so the remaining balance was recomputed against a
            // too-small total and the next partial return was rejected outright
            // for having no refundable payment.
            //
            // Cumulative and monotonic instead. An in-band refund has already
            // been accounted by the atomic claim above, so the stored value is
            // at or beyond this one and stays put; an out-of-band refund taken
            // in the provider's dashboard was never accounted, so this webhook
            // is the first evidence of it and raises the total. Terminal status
            // follows the arithmetic rather than being asserted — the SAME
            // `refundIsFull` the whole-order fanout above gates on, so the status
            // written here and the effects that ran can never disagree.
            //
            // Like the sibling refresh route (order.routes.ts, #1432), this guard
            // admits an ALREADY-partially-refunded row on purpose, so a second, genuinely
            // out-of-band partial refund can still raise the total. That is only
            // safe because resolveRefundSettlement refuses to read an unreported
            // amount — or a gateway's invoice-amount echo — as
            // settling a payment that already has a refund accounted. Without
            // that, the async settle webhook for an IN-BAND partial return would
            // land here and mark the payment fully refunded at its full amount,
            // stranding the remaining balance.
            ...(newStatus === 'completed' && payment.status !== 'refunded'
              ? {
                  status: (refundIsFull ? 'refunded' : 'partially_refunded') as
                    | 'refunded'
                    | 'partially_refunded',
                  refundedAmount: settledRefund,
                }
              : {}),
          },
        });

        // Append-only audit row — refund webhook receipt with raw payload.
        const refundToStatus =
          newStatus === 'completed' && payment.status !== 'refunded'
            ? refundIsFull
              ? ('refunded' as const)
              : ('partially_refunded' as const)
            : null;
        await recordPaymentEvent({
          paymentId: payment.id,
          storeId: payment.order?.storeId ?? '',
          orderId: payment.orderId,
          eventType: 'webhook',
          fromStatus: payment.status,
          toStatus: refundToStatus,
          provider,
          providerPayload: payload as Prisma.InputJsonValue,
          details: {
            flavour: 'refund',
            refundId: refundEvent.refundId,
            refundStatus: newStatus,
            refundReference: refundEvent.refundReference ?? null,
            // read back by the operator match (it must equal the claim's amount)
            reportedAmount: refundEvent.amount ?? null,
            ...(newStatus === 'completed' && heldOpenClaimIdUnverified
              ? { heldUnaccountedRefund: true, reason: 'open_claim_id_unverified' }
              : newStatus === 'completed' && heldUnaccountedEvent
                ? { heldUnaccountedRefund: true, reason: 'refund_amount_not_reported' }
                : newStatus === 'completed' && heldProvenanceUnknown
                  ? { heldUnaccountedRefund: true, reason: 'refund_provenance_unknown' }
                  : {}),
          },
        });

        // A refund reported without a usable amount changes nothing booked — it
        // needs a human — but it used to be a single info log. (The partial
        // out-of-band refund this block also used to raise is now booked above,
        // owner decision 2026-10-01.)
        if (newStatus === 'completed' && payment.order) {
          const alertStore = {
            id: payment.order.storeId,
            name: payment.order.store?.name ?? payment.order.storeId,
          };
          if (heldOpenClaimIdUnverified) {
            // Kashier: the refund API's id is not proven equal to the webhook's transactionId. An own refund is open on this
            // payment, so this event may be THAT refund under another id: booking it would count one refund twice. Held;
            // an operator matches it to the claim (matchRefundToClaim) or books it by hand.
            await alertUnbookedRefund({
              kind: 'held_open_claim_id_unverified',
              store: alertStore,
              orderRef: payment.order.orderNumber,
              body: `Order ${payment.order.orderNumber}: ${provider} reported refund ${refundEvent.refundId} (${refundEvent.amount ?? '?'} piastres) as completed with an id this system has not seen, while a refund sent from here is still open on the payment. NOT booked. If it is that refund (the provider uses a different id in the webhook), match it to the claim; if it is a separate refund, book it by hand.`,
              context: {
                paymentId: payment.id,
                refundId: refundEvent.refundId,
                reportedAmount: refundEvent.amount ?? null,
              },
            });
          } else if (heldUnaccountedEvent) {
            // #1477: a refund nothing has counted, reported without a usable
            // amount. The balance was held, so if this is a real second refund
            // the payment still looks refundable by that much — and a later
            // return would pay it out again.
            await alertUnbookedRefund({
              kind: 'held_unaccounted',
              store: alertStore,
              orderRef: payment.order.orderNumber,
              body: `Order ${payment.order.orderNumber}: the provider reported refund ${refundEvent.refundId} as completed without an amount this system can use, so the refunded total was NOT raised. Check the provider dashboard: if this is a new refund, the payment's refundable balance is overstated.`,
              context: { paymentId: payment.id, refundId: refundEvent.refundId },
            });
          } else if (heldProvenanceUnknown) {
            // PR 2279 audit P1: the payment predates the per-refund ledger, so a
            // refund with a usable amount was HELD (not added). If it is a new
            // second refund, the refundable balance is overstated.
            await alertUnbookedRefund({
              kind: 'held_provenance_unknown',
              store: alertStore,
              orderRef: payment.order.orderNumber,
              body: `Order ${payment.order.orderNumber}: the provider reported refund ${refundEvent.refundId} (${refundEvent.amount ?? '?'} piastres) as completed, but this payment predates the per-refund ledger, so the amount was NOT added to the refunded total. Check the provider dashboard: if this is a NEW refund, the payment's refundable balance is overstated and a later return could pay it out again.`,
              context: {
                paymentId: payment.id,
                refundId: refundEvent.refundId,
                reportedAmount: refundEvent.amount ?? null,
                refundedAmount: payment.refundedAmount,
              },
            });
          }
        }

        return { success: true, status: newStatus, orderId: payment.orderId };
      });
    }

    // Paid-amount reconciliation (money-integrity audit F3, 2026-07-02).
    // A 'completed' webhook only proves the provider says the invoice is
    // paid — never on its own that the AMOUNT paid matches `order.total`.
    // `webhookData.amount` is already normalized to piastres by every
    // adapter (`toMinor`, integer string math, in each Egyptian adapter), the same unit as
    // `payment.amount` (set from `order.total` at payment creation — see
    // `PaymentService.createPayment`), so this is a direct same-unit
    // comparison, not a currency-major-vs-minor mismatch. Gate on the
    // currencies matching too, as a belt-and-braces guard against a
    // provider reporting a foreign-currency settlement value we can't
    // meaningfully compare. A short-fall beyond a 5-piastre rounding
    // tolerance means: partial capture, reused/mis-configured invoice, or
    // a tampered total — none of which should ship goods. We deliberately
    // do NOT flip payment/order status in that case; we just log +
    // record + alert and acknowledge the webhook so the provider doesn't
    // retry forever.
    const isAmountUnderpaid =
      webhookData.status === 'completed' &&
      typeof webhookData.amount === 'number' &&
      Number.isFinite(webhookData.amount) &&
      webhookData.currency === payment.currency &&
      Math.abs(payment.amount - webhookData.amount) > AMOUNT_TOLERANCE_FILS &&
      webhookData.amount < payment.amount;

    if (isAmountUnderpaid) {
      logger.error(
        {
          paymentId: payment.id,
          orderId: payment.orderId,
          expectedFils: payment.amount,
          paidAmountFils: webhookData.amount,
          provider,
        },
        '[PAYMENT WEBHOOK] provider-reported paid amount is less than order total — holding order unpaid'
      );

      await recordPaymentEvent({
        paymentId: payment.id,
        storeId: payment.order?.storeId ?? '',
        orderId: payment.orderId,
        eventType: 'reconciliation',
        fromStatus: payment.status,
        toStatus: null,
        provider,
        providerPayload: payload as Prisma.InputJsonValue,
        details: {
          reason: 'paid_amount_mismatch',
          expectedFils: payment.amount,
          paidAmountFils: webhookData.amount,
          webhookEvent: webhookData.event,
        },
      });

      void sendAlert({
        level: 'p0',
        scope: 'store',
        store: {
          id: payment.order?.storeId ?? '',
          name: payment.order?.store?.name ?? payment.order?.storeId ?? 'unknown',
        },
        source: 'payment.webhook.amount_mismatch',
        title: 'payment.webhook.amount_mismatch',
        body: `Order ${payment.orderId}: ${provider} webhook reports paid ${webhookData.amount} piastres but the order total is ${payment.amount} piastres. Order was NOT marked as paid — investigate before fulfilling.`,
        context: {
          orderId: payment.orderId,
          paymentId: payment.id,
          provider,
          expectedFils: payment.amount,
          paidAmountFils: webhookData.amount,
        },
      }).catch(() => undefined);

      // Preserve the raw receipt on the Payment row for audit, but do NOT
      // touch `status` — leaving the order/payment exactly where they were
      // (typically pending/unpaid) rather than confirming a short payment.
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...((payment.metadata as object) || {}),
            webhookEvent: webhookData.event,
            paymentMethod: webhookData.paymentMethod,
            paidCurrency: webhookData.currency,
            paidAmount: webhookData.amount,
            amountMismatch: true,
          },
        },
      });

      return { success: true, status: webhookData.status, orderId: payment.orderId };
    }

    // Map status to our payment status
    let orderStatus: 'pending' | 'confirmed' = 'pending';
    let orderPaymentStatus: 'unpaid' | 'paid' | 'failed' | 'refunded' = 'unpaid';

    switch (webhookData.status) {
      case 'completed':
        orderStatus = 'confirmed';
        orderPaymentStatus = 'paid';
        break;
      case 'failed':
      case 'expired':
      case 'cancelled':
        orderPaymentStatus = 'failed';
        break;
      case 'refunded':
        orderPaymentStatus = 'refunded';
        break;
    }

    // Assert the ORDER transition BEFORE the payment write (adversarial audit
    // P2; mirrors payment-confirm.service.ts:222-228). The assert used to run
    // after `Payment.status` was already mutated — a stale/raced `completed`
    // webhook on a cancelled order threw at the order write but left
    // `Payment.status='completed'` + `Order.status='cancelled'` as durable
    // state on every Inngest retry: money captured for a cancelled order,
    // with no reconciler targeting that combination. Rejecting before ANY
    // write keeps the rows consistent; payment-reconcile-sweep now watches
    // for the captured-on-cancelled shape that arises when the capture
    // happened anyway at the provider.
    // A failure never sets the order status (only its paymentStatus, conditionally below), so only the
    // confirming and refunding statuses assert a transition.
    if (
      (webhookData.status === 'completed' || webhookData.status === 'refunded') &&
      payment.order &&
      // processing / shipped / delivered are marked paid without moving their fulfilment status (claimOrderPaid)
      !(
        webhookData.status === 'completed' &&
        ['processing', 'shipped', 'delivered'].includes(payment.order.status)
      )
    ) {
      assertValidTransition(payment.order.status, orderStatus);
    }

    // Order first, as ONE conditional update (M-049 / M-064): the webhook, the guest verify-on-return and the admin
    // Refresh can all settle the same order. Whoever wins `claimed` writes + fans out; a late "failed/expired"
    // never touches a paid order. (A refund event keeps its own path above.)
    // payment row first, then the order (the order every refund path locks in): no lock-order flip, no deadlock
    if (webhookData.status !== 'refunded') await lockPaymentRow(payment.id);
    let orderClaim: 'claimed' | 'already' | 'blocked' | 'none' = 'none';
    if (webhookData.status === 'completed') {
      const c = await claimOrderPaid(payment.orderId, payment.order?.storeId ?? currentStoreId());
      orderClaim = c === 'claimed' ? 'claimed' : c === 'already_paid' ? 'already' : 'blocked';
    } else if (
      webhookData.status === 'failed' ||
      webhookData.status === 'expired' ||
      webhookData.status === 'cancelled'
    ) {
      const c = await claimOrderFailed(payment.orderId, payment.order?.storeId ?? currentStoreId());
      orderClaim = c === 'claimed' ? 'claimed' : c === 'already_failed' ? 'already' : 'blocked';
    }
    if (orderClaim === 'blocked') {
      logger.warn(
        { paymentId: payment.id, orderId: payment.orderId, provider, status: webhookData.status },
        '[PAYMENT WEBHOOK] order already settled or no longer confirmable; order not changed'
      );
      if (webhookData.status === 'completed') {
        // Captured money on an order that went terminal between the assert above and the claim: the same loud
        // answer as the assert (retried, then dead-lettered into the existing P0 path), never a quiet 200.
        const cur = await prisma.order.findUnique({
          where: { id: payment.orderId, storeId: payment.order?.storeId ?? currentStoreId() },
          select: { status: true },
        });
        assertValidTransition(cur?.status ?? 'cancelled', 'confirmed');
      }
    }

    // Update payment. A terminal failure never overwrites a captured / refunded payment.
    const prevPaymentStatus = payment.status;
    await prisma.payment.updateMany({
      where: {
        id: payment.id,
        // never move captured / refunded money off its state (a late `pending`, a replayed `completed`)
        ...(webhookData.status === 'refunded'
          ? {}
          : { status: { notIn: paymentStatusesNotOverwrittenBy(webhookData.status) } }),
      },
      data: {
        status: webhookData.status,
        paidAt: webhookData.paidAt,
        metadata: {
          ...((payment.metadata as object) || {}),
          webhookEvent: webhookData.event,
          paymentMethod: webhookData.paymentMethod,
          paidCurrency: webhookData.currency,
          paidAmount: webhookData.amount,
        },
      },
    });

    // Duplicate-capture watch: a second captured payment on one order means
    // the customer paid twice (replayed create → two live invoices). Alert
    // finance — best-effort, never blocks webhook processing.
    if (webhookData.status === 'completed') {
      await alertIfDuplicateCapture(payment.id, payment.orderId, provider);
    }

    // Append-only audit row — every payment webhook receipt persists the
    // raw provider payload so a dispute 6+ months later can be replayed
    // even if `payments.metadata` has since been overwritten.
    await recordPaymentEvent({
      paymentId: payment.id,
      storeId: payment.order?.storeId ?? '',
      orderId: payment.orderId,
      eventType: 'webhook',
      fromStatus: prevPaymentStatus,
      toStatus: webhookData.status,
      provider,
      providerPayload: payload as Prisma.InputJsonValue,
      details: {
        webhookEvent: webhookData.event,
        paymentMethod: webhookData.paymentMethod,
        paidCurrency: webhookData.currency,
        paidAmount: webhookData.amount,
      },
    });

    // completed / failed were settled above by the conditional claim. A `refunded` status keeps its original
    // unconditional write (the refund paths own that state).
    if (webhookData.status === 'refunded') {
      await prisma.order.update({
        where: { id: payment.orderId, storeId: currentStoreId() },
        data: { status: orderStatus, paymentStatus: orderPaymentStatus },
      });
      orderClaim = 'claimed';
    }
    // Bust the admin aggregated-customers snapshot — a paymentStatus transition changes its counts.
    if (orderClaim === 'claimed' && payment.order?.storeId)
      await invalidateCustomersCache(payment.order.storeId);

    // Online-payment notifications fire HERE, not at order creation. order.service.ts
    // intentionally skips its inngest.send + socket emit for non-COD orders so a
    // customer who abandons at the gateway doesn't produce a phantom "new order"
    // ping on the merchant side. We fire on the FIRST transition out of pending:
    //   - completed → "new order" fanout (emails, push, dispatcher, socket toast)
    //   - failed / expired / cancelled → "payment failed" push to admins only
    //     (customer sees the failure inline at the gateway / checkout error page)
    // Idempotency lives upstream in the webhook route (checkIdempotency), so a
    // duplicate webhook never reaches this code path twice.
    const order = payment.order;
    const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
    const customerName =
      `${order.customer?.firstName ?? shipping.firstName ?? ''} ${order.customer?.lastName ?? shipping.lastName ?? ''}`.trim() ||
      order.customer?.email ||
      shipping.email ||
      'Customer';

    if (webhookData.status === 'completed' && orderClaim === 'claimed') {
      // PROVIDERS-3: a settled live payment is evidence for the provider (same call as the pull-side confirm).
      void recordPaymentSettled({
        storeId: order.storeId,
        provider: payment.provider,
        paymentId: payment.id,
      });
      inngest
        .send({
          name: 'order/created',
          data: {
            orderId: order.id,
            storeId: order.storeId,
            paymentMethod: payment.provider,
            locale: order.locale ?? undefined,
          },
        })
        .catch((err: unknown) =>
          logger.error(
            { err, orderId: order.id },
            '[PAYMENT WEBHOOK] Failed to enqueue post-payment order/created'
          )
        );

      try {
        socketService.newOrderNotification(order.storeId, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          total: order.total,
          customerName,
        });
      } catch (notifyError) {
        logger.error(
          { err: notifyError, orderId: order.id },
          '[PAYMENT WEBHOOK] Socket emit failed'
        );
      }
    } else if (
      orderClaim === 'claimed' &&
      (webhookData.status === 'failed' ||
        webhookData.status === 'expired' ||
        webhookData.status === 'cancelled')
    ) {
      // Card-testing bookkeeping (SP5 task 4): only a DECLINE counts, not a
      // customer who cancelled / let the invoice expire. Idempotent per payment
      // (webhooks retry) and never throws.
      if (webhookData.status === 'failed') {
        void CardTestingGuard.recordDecline({
          storeId: order.storeId,
          orderId: order.id,
          paymentId: payment.id,
        });
      }
      OneSignalService.notifyAdminsOfPaymentFailure({
        orderId: order.id,
        orderNumber: order.orderNumber,
        storeId: order.storeId,
        storeName: order.store?.name ?? order.storeId,
        customerName,
        total: order.total,
        currency: order.currency,
        paymentMethod: payment.provider,
        reason: webhookData.status,
      }).catch(err => {
        logger.error(
          { err, orderId: order.id },
          '[PAYMENT WEBHOOK] Payment-failure notification failed'
        );
        // Pure notification (not money): don't re-throw — retrying the webhook
        // step would risk a duplicate push. But don't leave it silent either:
        // surface a throttled info-level alert so a lost failed-payment signal
        // is at least visible to an operator.
        void sendAlert({
          level: 'info',
          scope: 'platform',
          source: 'payment.webhook.failure_notify_failed',
          title: 'payment-failure admin push failed',
          body: `Could not notify store admins of a failed/expired/cancelled payment for order ${order.orderNumber}.`,
          context: { orderId: order.id, storeId: order.storeId },
        }).catch(() => undefined);
      });
    }

    return { success: true, status: webhookData.status, orderId: payment.orderId };
  }

  /** The DO money client of the store that owns `request.orderId`, or null (Postgres). The store comes from the request. */
  private static async doStoreOfOrder(storeId?: string): Promise<{ money: MoneyClient } | null> {
    const sid = storeId ?? currentStoreIdOrNull();
    if (!sid) return null;
    const money = await storeMoney(sid);
    return money ? { money } : null;
  }

  /**
   * A webhook for a store on its Durable Object (Ruling CF-PAY-1). The signature was verified by `verifyWebhookDelivery`.
   * A gateway whose delivery leaves a money-deciding field unsigned (Kashier) is confirmed server-to-server HERE, outside the
   * DO, and ONLY the gateway's answer is applied; no answer = 503 and nothing written. The DO applies it in one section and a
   * replay of the same signed event applies once. External money facts are recorded in full: the engine alerts, it never
   * rejects a refund the gateway says happened.
   */
  private static async handleWebhookOnDo(
    money: MoneyClient,
    p: IPaymentProvider,
    provider: PaymentProvider,
    delivered: WebhookPayload,
    storeId: string
  ): Promise<{ success: boolean; status?: string; orderId?: string }> {
    let data = delivered;
    let confirmed: { kind: string; status: string } | null = null;
    if (p.confirmWebhook) {
      try {
        const out = await p.confirmWebhook(delivered);
        data = out.payload;
        // the DO folds the gateway record back to SUCCESS / FAILURE / PENDING; the payload it applies is the confirmed one
        const folded = data.refund ? data.refund.status : data.status;
        confirmed = {
          kind: data.refund ? 'refund' : 'payment',
          status:
            folded === 'completed'
              ? 'SUCCESS'
              : folded === 'failed' || folded === 'expired' || folded === 'cancelled'
                ? 'FAILURE'
                : 'PENDING',
        };
        if (out.confirmation.mismatch)
          void sendAlert({
            level: 'p1',
            scope: 'store',
            store: { id: storeId, name: storeId },
            source: 'payment.webhook.unconfirmed_label',
            title: `${provider} webhook label disagreed with the gateway - ${data.transactionId}`,
            body: `A signed ${provider} delivery claimed ${out.confirmation.claimed.kind}/${out.confirmation.claimed.status}, but the gateway's own record says ${out.confirmation.confirmed.kind}/${out.confirmation.confirmed.status}. Only the gateway record was applied.`,
            context: {
              provider,
              storeId,
              claimed: out.confirmation.claimed,
              confirmed: out.confirmation.confirmed,
            },
          }).catch(() => undefined);
      } catch (err) {
        throw new AppError(
          503,
          'WEBHOOK_UNCONFIRMED',
          `The gateway could not confirm this webhook; it was not applied and will be retried (${(err instanceof Error ? err.message : String(err)).slice(0, 200)})`
        );
      }
    }
    // The signed event identity: deterministic from the verified payload, so a true redelivery collides and a later,
    // different status of the same payment does not.
    const eventId = [
      data.event,
      data.refund?.refundId ?? '',
      data.transactionId,
      data.refund?.status ?? data.status,
      data.refund?.amount ?? data.amount,
    ].join(':');
    const base = {
      provider,
      eventId,
      kind: data.refund ? ('refund' as const) : ('payment' as const),
      event: data.event,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      paidAt: data.paidAt ? data.paidAt.getTime() : null,
      paymentMethod: data.paymentMethod ?? null,
      refund: data.refund
        ? {
            refundId: data.refund.refundId,
            status: data.refund.status,
            amount: data.refund.amount ?? null,
            refundReference: data.refund.refundReference ?? null,
          }
        : undefined,
      rawPayload: data.rawPayload,
    } satisfies Omit<DoWebhookInput, 'providerRef'>;
    let result;
    try {
      // The reference the payment was created with: the transaction id, else the invoice id.
      try {
        result = await money.paymentWebhook({
          input: { ...base, providerRef: data.transactionId },
          confirmed,
        });
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'PAYMENT_NOT_FOUND' && data.invoiceId)) throw e;
        result = await money.paymentWebhook({
          input: { ...base, providerRef: data.invoiceId },
          confirmed,
        });
      }
    } catch (e) {
      if (e instanceof AppError && e.code === 'PAYMENT_NOT_FOUND') {
        logger.error(
          { transactionId: data.transactionId, storeId },
          '[PAYMENT WEBHOOK] Payment not found in the store Durable Object'
        );
        return { success: true, orderId: undefined }; // acknowledged, as on Postgres
      }
      throw e;
    }
    for (const a of result.alerts)
      void sendAlert({
        level: 'p1',
        scope: 'store',
        store: { id: storeId, name: storeId },
        source: `payment.webhook.${a.kind}`,
        title: `${provider} webhook: ${a.kind}`,
        body: a.body,
        context: { storeId, paymentId: a.paymentId, orderId: a.orderId, ...(a.context ?? {}) },
      }).catch(() => undefined);
    if (result.outcome === 'applied') {
      await PaymentService.afterWebhookOnDo(storeId, provider, result);
    }
    return { success: true, status: result.paymentStatus, orderId: result.orderId };
  }

  /**
   * A payment the gateway itself reports CAPTURED, found by a poll rather than a webhook (the auto-cancel sweep), applied to a
   * store on its Durable Object through the same `paymentWebhook` section a delivered webhook uses (Ruling CF-JOBS-3). The
   * status came from a server-to-server call, so it is the confirmed gateway record; a replay of the same capture applies once.
   * Throws the engine's refusal (for example `INVALID_STATUS_TRANSITION` when the order already left pending) for the caller.
   */
  static async applyCapturedStatusOnDo(
    storeId: string,
    payment: { provider: string; transactionId: string; amount: number; currency?: string },
    providerStatus: { paidAmount?: number; paidCurrency?: string; currency?: string }
  ): Promise<{ outcome: string; orderId: string }> {
    const money = await storeMoney(storeId);
    if (!money)
      throw new AppError(500, 'NOT_A_DO_STORE', 'store is not served by its Durable Object');
    const result = await money.paymentWebhook({
      input: {
        provider: payment.provider,
        eventId: `status-poll:${payment.transactionId}:completed`,
        providerRef: payment.transactionId,
        kind: 'payment',
        status: 'completed',
        amount: providerStatus.paidAmount ?? payment.amount,
        currency:
          providerStatus.paidCurrency ?? providerStatus.currency ?? payment.currency ?? null,
        rawPayload: { source: 'auto_cancel_sweep' },
      },
      confirmed: { kind: 'payment', status: 'SUCCESS' },
    });
    for (const a of result.alerts)
      void sendAlert({
        level: 'p1',
        scope: 'store',
        store: { id: storeId, name: storeId },
        source: `payment.webhook.${a.kind}`,
        title: `${payment.provider} status poll: ${a.kind}`,
        body: a.body,
        context: { storeId, paymentId: a.paymentId, orderId: a.orderId, ...(a.context ?? {}) },
      }).catch(() => undefined);
    if (result.outcome === 'applied')
      await PaymentService.afterWebhookOnDo(storeId, payment.provider as PaymentProvider, result);
    return { outcome: result.outcome, orderId: result.orderId };
  }

  /** The post-commit work of an applied webhook: the same fan-out as the Postgres branch. */
  private static async afterWebhookOnDo(
    storeId: string,
    provider: PaymentProvider,
    r: Awaited<ReturnType<MoneyClient['paymentWebhook']>>
  ): Promise<void> {
    await invalidateCustomersCache(storeId);
    const order = await (
      await storeDb(storeId)
    ).order.findFirst({
      where: { id: r.orderId, storeId },
      select: {
        id: true,
        orderNumber: true,
        total: true,
        currency: true,
        locale: true,
        shippingAddress: true,
      },
    });
    if (!order) return;
    const addr = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
    const customerName =
      `${addr.firstName ?? ''} ${addr.lastName ?? ''}`.trim() || addr.email || 'Customer';
    if (r.postCommit.includes('order_paid')) {
      void recordPaymentSettled({ storeId, provider, paymentId: r.paymentId });
      inngest
        .send({
          name: 'order/created',
          data: {
            orderId: order.id,
            storeId,
            paymentMethod: provider,
            locale: order.locale ?? undefined,
          },
        })
        .catch((err: unknown) =>
          logger.error(
            { err, orderId: order.id },
            '[PAYMENT WEBHOOK] Failed to enqueue post-payment order/created'
          )
        );
      try {
        socketService.newOrderNotification(storeId, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          total: order.total,
          customerName,
        });
      } catch (err) {
        logger.error({ err, orderId: order.id }, '[PAYMENT WEBHOOK] Socket emit failed');
      }
    }
    if (r.postCommit.includes('payment_failed')) {
      if (r.paymentStatus === 'failed')
        void CardTestingGuard.recordDecline({ storeId, orderId: order.id, paymentId: r.paymentId });
      OneSignalService.notifyAdminsOfPaymentFailure({
        orderId: order.id,
        orderNumber: order.orderNumber,
        storeId,
        storeName: storeId,
        customerName,
        total: order.total,
        currency: order.currency,
        paymentMethod: provider,
        reason: r.paymentStatus,
      }).catch(err =>
        logger.error(
          { err, orderId: order.id },
          '[PAYMENT WEBHOOK] Payment-failure notification failed'
        )
      );
    }
    if (r.postCommit.includes('order_reversed'))
      // the money steps ran in the DO section (idempotent); the fan-out sends the GL reversal and the notifications
      await OrderService.applyRefundEffects(storeId, r.orderId);
  }

  /**
   * PaymentService.refund for a store on its Durable Object (Ruling CF-PAY-1): the claim is committed BEFORE the provider
   * call, the outcome AFTER it, each as one DO section; a double attempt for one refundKey is refused (REFUND_ALREADY_ISSUED)
   * and a second claim cannot exceed the payment balance (the DO thread replaces the payment row lock).
   */
  private static async refundOnDo(
    money: MoneyClient,
    request: RefundRequest,
    provider: PaymentProvider | undefined,
    storeId: string
  ): Promise<RefundResponse & { wholeOrderEffectsApplied: boolean }> {
    if (!request.transactionId) {
      throw new AppError(
        400,
        'PAYMENT_NOT_REFUNDABLE',
        'This payment has no provider transaction and cannot be refunded at the gateway. Use a manual refund method.'
      );
    }
    const db = await storeDb(storeId);
    const matches = await db.payment.findMany({
      where: { transactionId: request.transactionId, order: { storeId } },
      select: {
        id: true,
        orderId: true,
        provider: true,
        status: true,
        amount: true,
        refundedAmount: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    if (matches.length > 1)
      throw new AppError(
        409,
        'AMBIGUOUS_PAYMENT',
        'This transaction id matches more than one payment. Refund it from the provider dashboard and contact support.'
      );
    const payment = matches[0];
    if (!payment) throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    if (payment.provider === 'instapay')
      throw new AppError(
        409,
        'MANUAL_PROVIDER_REFUND',
        'InstaPay payments are refunded by the merchant outside the system. Use a manual refund.'
      );
    if (request.amount != null && request.amount <= 0)
      throw new AppError(
        400,
        'INVALID_REFUND_AMOUNT',
        'Refund amount must be greater than zero. Omit it to refund the full payment.'
      );
    const alreadyRefunded = payment.refundedAmount ?? 0;
    const refundableRemaining = payment.amount - alreadyRefunded;
    let claim;
    try {
      claim = await money.refundBegin({
        paymentId: payment.id,
        amount: request.amount ?? undefined,
        refundKey: request.refundKey,
        reason: request.reason,
        itemLevel: request.itemLevel,
      });
    } catch (e) {
      if (e instanceof AppError && e.code === 'PAYMENT_FULLY_REFUNDED')
        throw new AppError(
          400,
          'ALREADY_REFUNDED',
          'This payment has already been refunded in full.'
        );
      throw e;
    }
    const providerName = provider || (payment.provider as PaymentProvider);
    const release = async (reason: string, err: unknown) => {
      try {
        await money.refundRelease({
          claimId: claim.claimId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (releaseError) {
        logger.error(
          { err: releaseError, paymentId: payment.id, claimId: claim.claimId },
          '[PAYMENT] failed to release refund claim after a refund that was not sent - balance overstated, manual reconciliation required'
        );
      }
    };
    let providerImpl: IPaymentProvider;
    try {
      providerImpl = await factory.getProvider(providerName, storeId);
    } catch (resolveError) {
      await release('provider_unavailable', resolveError);
      throw resolveError;
    }
    let response: RefundResponse;
    try {
      response = await providerImpl.refund({
        transactionId: request.transactionId,
        reason: request.reason,
        amount:
          request.amount == null && alreadyRefunded > 0 ? refundableRemaining : request.amount,
      });
    } catch (providerError) {
      if (providerError instanceof ProviderRejectedError) {
        await release('provider_rejected', providerError);
        throw providerError;
      }
      await money
        .refundIndeterminate({
          claimId: claim.claimId,
          error: providerError instanceof Error ? providerError.message : String(providerError),
        })
        .catch(eventError =>
          logger.error(
            { err: eventError, paymentId: payment.id, claimId: claim.claimId },
            '[PAYMENT] failed to record an indeterminate refund - the claim stands, reconcile manually'
          )
        );
      throw markRefundMayHaveExecuted(
        new AppError(
          502,
          'PROVIDER_REFUND_INDETERMINATE',
          'The payment provider did not confirm the refund (timeout or server error), so it may have gone through. It is recorded as pending reconciliation - check the provider dashboard before refunding again.'
        )
      );
    }
    // The provider moved the money: an EXTERNAL fact. Record it; a failure here is told to the caller as "may have executed".
    try {
      await money.refundComplete({
        claimId: claim.claimId,
        refundId: response.refundId as string,
        providerStatus: response.status,
        reason: request.reason,
      });
      await invalidateCustomersCache(storeId);
    } catch (txError) {
      logger.error(
        {
          err: txError,
          paymentId: payment.id,
          refundId: response.refundId,
          refundAmount: claim.amount,
        },
        '[PAYMENT] DO section failed AFTER provider refund succeeded - manual reconciliation required'
      );
      throw markRefundMayHaveExecuted(txError);
    }
    if (claim.flipsOrder) {
      try {
        // the whole-order reversal (stock, coupon, loyalty, wallet, backorders) in one DO section, then the fan-out
        await money.refundBook({ orderId: payment.orderId, external: true });
        await OrderService.applyRefundEffects(storeId, payment.orderId);
      } catch (effectsError) {
        throw markRefundMayHaveExecuted(effectsError);
      }
    } else if (!request.refundKey && response.refundId) {
      try {
        await OrderService.recordRefundOutsideReturn(
          storeId,
          payment.orderId,
          { providerRefundId: response.refundId, amount: claim.amount },
          { sendNow: true }
        );
      } catch (sendError) {
        logger.error(
          { err: sendError, paymentId: payment.id, orderId: payment.orderId },
          '[PAYMENT] partial refund outside a return: order/refunded not sent - the GL entry is missing'
        );
        await alertUnbookedRefund({
          kind: 'partial_no_gl',
          store: { id: storeId, name: storeId },
          orderRef: payment.orderId,
          body: `A partial refund of ${claim.amount} piastres was sent to the provider outside a return, but its ledger event could not be queued: book it by hand.`,
          context: { paymentId: payment.id, orderId: payment.orderId, claimId: claim.claimId },
        });
      }
    }
    return { ...response, wholeOrderEffectsApplied: claim.flipsOrder };
  }

  /**
   * Get payment by order ID
   */
  static async getPaymentByOrderId(orderId: string) {
    return prisma.payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Retry a failed payment: a SHORT read in the store's scope, then the provider call with no
   * transaction open (behind the breaker), then one short transaction to record. Call it with
   * no request transaction held (the route resolves the store through a definer and calls this
   * bare); `storeId` is the payment's own store.
   */
  static async retryPayment(
    paymentId: string,
    provider: PaymentProvider | undefined,
    storeId: string
  ): Promise<PaymentResponse> {
    const payment = await withStore(storeId, () =>
      prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          order: {
            include: {
              items: { include: { product: true } },
              customer: true,
              store: true,
            },
          },
        },
      })
    );

    if (!payment || payment.order.storeId !== storeId) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }

    if (payment.status !== 'failed') {
      throw new AppError(400, 'INVALID_STATE', 'Payment is not in failed state');
    }

    const order = payment.order;

    // Guest orders carry customer details on order.shippingAddress (JSON),
    // not on order.customer (which is null for guests). A provider that rejects an
    // empty CustomerEmail applies on retry too — fall through to shippingAddress
    // fields before defaulting.
    const retryShipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
    return this.createPayment(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        // Amount due: the order value less any customer-wallet spend (D1).
        // === order.total for every order that did not use the wallet.
        amount: order.total - (order.walletAmount ?? 0),
        currency: order.currency as Currency,
        customer: {
          id: order.customerId ?? `guest-${order.id}`,
          name:
            `${order.customer?.firstName ?? retryShipping.firstName ?? ''} ${order.customer?.lastName ?? retryShipping.lastName ?? ''}`.trim() ||
            'Customer',
          email: order.customer?.email || retryShipping.email || '',
          phone: retryShipping.phone || undefined,
        },
        items: buildPaymentLineItems(order.items),
        callbackUrl: `${config.webUrl}/checkout/success`,
        errorUrl: `${config.webUrl}/checkout/error`,
        webhookUrl: paymentWebhookUrl(provider || payment.provider, order.storeId),
      },
      provider || (payment.provider as PaymentProvider),
      order.storeId
    );
  }

  /**
   * Clear provider cache (call when config changes)
   */
  static clearCache(storeId?: string): void {
    factory.clearCache(storeId);
  }
}

/** The ambient store id, or null outside a store scope (never throws). */
function currentStoreIdOrNull(): string | null {
  try {
    return currentStoreId() || null;
  } catch {
    return null;
  }
}
