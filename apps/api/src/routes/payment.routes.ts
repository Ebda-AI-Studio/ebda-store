import { Router, Request, Response, NextFunction } from 'express';
import { storeDb, storeMoney } from '../lib/repo-factory';
import { requestHoldsOrderViewToken, requireOrderAccess } from '../lib/order-view-token';
import { maskReceiptPayerPii } from '../services/payment-providers/instapay-receipt.service';
import {
  INSTAPAY_DEFAULT_EXPIRY_HOURS,
  goldAllowsDeferredPayment,
  storefrontOrigin,
} from '@ebda/shared';
import { assertGoldPaymentAllowed } from '../services/gold-rate/payment-policy';
import { z } from 'zod/v3';
import { CardTestingGuard } from '../services/card-testing-guard.service';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { PaymentProvider, Currency } from '../services/payment-providers/types';
import { authenticate, optionalAuthenticate, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requirePermission } from '../middleware/rbac';
import { withStore, type Prisma } from '@ebda/database';
import {
  paymentLimiter,
  auditLog,
  auditLogStrict,
  uploadLimiter,
  dailyUploadLimiter,
} from '../middleware/security';
import { config } from '../config';
import { getAuthUser, resolvePublicStoreId } from '../utils/store-helpers';
import {
  getOrderStoreId,
  getPaymentStoreId,
  resolvePaymentEventsStore,
  resolveStoreFromWebhookRef,
} from '../lib/definer';
import { OrderService } from '../services/order.service';
import { checkStoreAccess } from '../middleware/store-access';
import { onAccessD1 } from '../services/platform/access-d1';
import { recordPaymentEventForStore } from '../services/payment-event.service';
import { sendAlert } from '../services/alerts.service';
import logger from '../lib/logger';
import { buildPaymentLineItems } from '../lib/payment-line-items';
import {
  alertOrphanedProviderInvoice,
  type OrphanedProviderInvoice,
} from '../services/payment-providers/orphaned-invoice-alert';

import {
  INSTAPAY_RECEIPT_MAX_BYTES,
  REGION,
  codFeeForOrder,
  instapayReceiptFieldsSchema,
} from '@ebda/shared';
import multer from 'multer';
import { AppError } from '../middleware/error-handler';
import { InstapayService, runPostCommit } from '../services/payment-providers/instapay.service';
import {
  codCollectMinor,
  codFeeConfigFromRow,
  codProvider,
} from '../services/payment-providers/cod.provider';
import { isProviderAvailable } from '../services/payment-providers/provider-health';
import { enabledMethods, METHOD_LABELS } from '../services/payment-providers/provider-methods';
import { PaymentProviderError } from '../services/payment-providers/types';
import { paymentWebhookUrl } from '../services/payment-providers/webhook-url';
import { customersById, runInStoreCtx } from '../lib/jobs/store-db';
import { idempotencyKeyOf, withIdempotencyKey } from '../lib/money-idempotency';
import { refundMayHaveExecuted } from '../services/payment-providers/refund-outcome';
const router = Router();

// ==========================================
// Validation Schemas
// ==========================================

// Validate that a URL is either a relative path or an absolute URL whose origin
// matches the platform's web URL or a verified store domain. This prevents
// open-redirect attacks where an attacker supplies an external domain as a callback URL.
function platformUrlOrRelative(url: string): boolean {
  // Allow relative paths (must start with /)
  if (url.startsWith('/')) return true;

  // For absolute URLs, only permit those pointing to our own web origin.
  // Store custom domain URLs are resolved server-side in the callback handler,
  // so client-supplied absolute URLs must match the platform origin.
  try {
    const parsed = new URL(url);
    const allowed = new URL(config.webUrl);
    return parsed.origin === allowed.origin;
  } catch {
    return false;
  }
}

const createPaymentSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.enum(['cod', 'instapay', 'paymob', 'kashier', 'fawry', 'geidea']).optional(),
  /**
   * Which of the provider's methods the customer picked (Fawry: reference code or card;
   * Paymob: one integration). Absent = the provider's own page offers them all.
   */
  method: z.enum(['card', 'meeza', 'wallet', 'valu', 'payatfawry']).optional(),
  // Accept relative paths (preferred — server absolutifies against the order's
  // store domain) OR absolute URLs on the platform origin. We do NOT chain
  // `.url()` because that rejects relative paths; the refinement handles both
  // shapes explicitly.
  successUrl: z
    .string()
    .min(1)
    .optional()
    .refine(val => val === undefined || platformUrlOrRelative(val), {
      message: 'successUrl must be a relative path or a URL on the platform domain',
    }),
  errorUrl: z
    .string()
    .min(1)
    .optional()
    .refine(val => val === undefined || platformUrlOrRelative(val), {
      message: 'errorUrl must be a relative path or a URL on the platform domain',
    }),
});

const refundSchema = z.object({
  // BE:S-12: bounded, both land in the audit log and the provider call.
  transactionId: z.string().min(1).max(128),
  /** Narrows the lookup when two providers hold the same reference string (Ruling ITEST-14). */
  provider: z.enum(['paymob', 'kashier', 'fawry']).optional(),
  amount: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
});

// GET /payments/methods is public: its query is parsed, not cast (F-9-prune triage). Shapes only; the service decides which
// provider / currency exist, so a valid value is never refused here.
const methodsQuerySchema = z.object({
  amount: z.coerce.number().int().min(1).max(1_000_000_000).optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  provider: z
    .string()
    .regex(/^[a-z_]{2,32}$/)
    .optional(),
});

// BE:S-13: the retry body names at most a provider.
const retryBodySchema = z.object({ provider: z.enum(['paymob', 'kashier', 'fawry']).optional() });

// ==========================================
// Helper Functions
// ==========================================

// getUserFromRequest replaced by shared getAuthUser from ../utils/store-helpers

/**
 * An order of `storeId` with its lines (+ product), its shopper and its storefront, read through the store's own backend
 * (NEON-ZERO: Postgres is gone from the Worker; `storeDb` is the `prisma` proxy for a Postgres store, so that path reads
 * exactly as before). `Order -> User` and `Order -> Store` are platform rows a Durable Object order cannot join, so both are
 * read beside it (Ruling NZ-A-3), giving the same shape on both backends. Null when no order matches `where`.
 */
async function readOrderForPayment(storeId: string, where: Prisma.OrderWhereInput) {
  return withStore(storeId, async () => {
    const db = await storeDb(storeId);
    const order = await db.order.findFirst({
      where: { ...where, storeId },
      include: { items: { include: { product: true } } },
    });
    if (!order) return null;
    const customer = order.customerId
      ? ((await customersById(storeId, [order.customerId])).get(order.customerId) ?? null)
      : null;
    const store = await db.store.findUnique({
      where: { id: storeId },
      select: { domain: true, slug: true, ownerId: true },
    });
    return { ...order, customer, store };
  });
}

/** INSTAPAY-UPLOAD-1: does this signed-in customer own this order? A missing order or another customer's is false. */
async function customerOwnsOrder(customerId: string, orderId: string): Promise<boolean> {
  const storeId = await getOrderStoreId(orderId);
  if (!storeId) return false;
  return withStore(storeId, async () => {
    const db = await storeDb(storeId);
    const row = await db.order.findFirst({
      where: { id: orderId, storeId, customerId },
      select: { id: true },
    });
    return row !== null;
  });
}
const requireInstapayOrderAccess = requireOrderAccess(customerOwnsOrder);

/**
 * Ruling NZ-MONEY-2 (review NEW-1 of PR 455): an EXISTING payment's reference is handed out again only when D1 routes it. A
 * store on its Durable Object writes the payment's still-queued index rows now and reads them back, else 503
 * ENTITY_INDEX_UNAVAILABLE (retryable: the next call returns the same payment). A Postgres store has no index to wait for.
 */
async function assertPaymentRoutable(storeId: string, paymentId: string): Promise<void> {
  const money = await storeMoney(storeId);
  if (money) await money.paymentIndexCheck({ paymentId });
}

/** A payment row of `storeId` through the store's own backend (see `readOrderForPayment`). */
async function readPayment<T>(
  storeId: string,
  fn: (db: Awaited<ReturnType<typeof storeDb>>) => Promise<T>
): Promise<T> {
  return withStore(storeId, async () => fn(await storeDb(storeId)));
}

// ==========================================
// Routes
// ==========================================

/**
 * GET /payments/config
 * Get payment configuration for Egypt providers
 */
router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Under strict RLS a read with no store scope sees nothing, so the store is
    // resolved first (validated X-Store-ID / host, the same resolver the public
    // routes use) and every read below runs inside its scope.
    const storeId = await resolvePublicStoreId(req);
    // BE:S-22: no resolvable store is a 404, never the platform default (and never "first store").
    if (!storeId) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

    const data = await runInStoreCtx(storeId, () => loadCheckoutPaymentConfig(storeId));

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * What the checkout may offer THIS store right now. A method whose provider is
 * in an outage (open circuit) is left out of `providers`/`methods` and named in
 * `unavailable`, so the checkout keeps working with COD / InstaPay / the other
 * gateways instead of offering a button that cannot succeed (Review Focus 5).
 */
async function loadCheckoutPaymentConfig(storeId: string | undefined) {
  const allProviders = await PaymentService.getAvailableProviders(storeId);
  const unavailable: string[] = [];
  // Which of each gateway's methods this merchant turned on (Paymob integration ids, Fawry
  // reference code / card, Kashier card / wallet): the storefront labels the choices from it.
  const methodsByProvider: Record<
    string,
    Array<{ code: string; name: string; nameAr: string }>
  > = {};
  const providers = allProviders.filter(p => {
    const ok = !storeId || isProviderAvailable(storeId, p);
    if (!ok) unavailable.push(p);
    return ok;
  });
  for (const p of providers) {
    const settings = await PaymentService.getProviderSettings(p, storeId);
    methodsByProvider[p] = enabledMethods(p, settings).map(code => ({
      code,
      name: METHOD_LABELS[code]?.name ?? code,
      nameAr: METHOD_LABELS[code]?.nameAr ?? code,
    }));
  }

  // Check if COD is enabled for this store. There is no platform-level (storeId NULL) COD
  // row for the app role: strict RLS hides it and the tenant guard refuses an unscoped read
  // (R-EBDA-007), so only the store's own row counts.
  // `fixedFee` + `percentBps` so the checkout can quote the WHOLE fee before the
  // order is placed (ruling MONEYB-3) with `codFeeForOrder`, the function the
  // order uses to freeze it.
  let codConfig: {
    fixedFee: number;
    percentBps: number;
    displayName: string;
    displayNameAr: string | null;
  } | null = null;
  const codRecord = storeId
    ? await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({
        where: { storeId, provider: 'cod' as const, isEnabled: true },
      })
    : null;
  if (codRecord) {
    codConfig = {
      ...codFeeConfigFromRow(codRecord),
      displayName: codRecord.displayName || 'Cash on Delivery',
      displayNameAr: codRecord.displayNameAr,
    };
  }

  // InstaPay (manual transfer). Only that it is on, its name and its hold window:
  // the merchant's handle and phone are shown after the order exists, not to
  // every visitor of the checkout.
  let instapayConfig: {
    displayName: string;
    displayNameAr: string | null;
    expiryHours: number;
  } | null = null;
  if (storeId) {
    const ip = await InstapayService.getConfig(storeId);
    if (ip) {
      const hours = Number((ip.settings as { expiryHours?: unknown } | null)?.expiryHours);
      instapayConfig = {
        displayName: ip.displayName || 'InstaPay',
        displayNameAr: ip.displayNameAr ?? 'إنستاباي',
        expiryHours: Number.isFinite(hours) && hours > 0 ? hours : INSTAPAY_DEFAULT_EXPIRY_HOURS,
      };
    }
  }

  // A default the storefront can actually submit: the env default if offerable,
  // else the first listed provider, else COD, else InstaPay, else null.
  const offerable = new Set<string>(providers as unknown as string[]);
  if (codConfig) offerable.add('cod');
  if (instapayConfig) offerable.add('instapay');
  const envDefault = config.defaultPaymentProvider;
  const defaultProvider =
    envDefault && offerable.has(envDefault)
      ? envDefault
      : (providers[0] ?? (codConfig ? 'cod' : instapayConfig ? 'instapay' : null));

  // Ruling SHARIA-GOLD-1: a cart with gold hides COD + installments unless the merchant allowed them. The
  // storefront only hides the options; the API refuses them (assertGoldPaymentAllowed) whatever it shows.
  const goldStore = storeId
    ? await (
        await storeDb(storeId)
      ).store.findUnique({ where: { id: storeId }, select: { settings: true } })
    : null;
  const goldPrepaidOnly = !goldAllowsDeferredPayment(goldStore?.settings);

  return {
    providers,
    goldPrepaidOnly,
    /** Per online provider, the methods the merchant enabled. */
    methods: methodsByProvider,
    cod: codConfig,
    instapay: instapayConfig,
    /** Methods that are configured but down right now (open circuit); they come back by themselves. */
    unavailable,
    defaultProvider,
    defaultCurrency: config.defaultCurrency,
    supportedCurrencies: ['EGP'],
    supportedMethods: ['card', 'meeza', 'wallet', 'valu', 'payatfawry', 'instapay', 'cod'],
    testMode: config.paymentTestMode,
  };
}

/**
 * GET /payments/methods
 * Get available payment methods for an amount
 */
router.get('/methods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = methodsQuerySchema.parse(req.query);
    const amount = q.amount ?? 1000;
    const currency = (q.currency?.toUpperCase() || REGION.currency) as Currency;
    const provider = q.provider as PaymentProvider | undefined;
    const storeId = await resolvePublicStoreId(req);
    if (!storeId) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found'); // BE:S-22

    const methods = await PaymentService.getPaymentMethods(amount, currency, provider, storeId);

    res.json({
      success: true,
      data: { methods },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /payments/create
 * Create a payment for an order
 *
 * Three shapes, one rule: NO external call ever runs inside a request transaction
 * (a provider call under a 30 s interactive transaction is how a slow gateway
 * turns into P2028 and a half-written order).
 *
 *  - COD / InstaPay: no network at all, so ONE short tenant transaction writes
 *    the payment (and, for InstaPay, puts the order on hold).
 *  - Online gateways: short transaction(s) to read -> the provider call with NO
 *    transaction open, behind the per-(store, provider) circuit breaker -> a short
 *    transaction to record the payment. The order itself was committed earlier by
 *    /public/orders.
 */
router.post(
  '/create',
  optionalAuthenticate,
  // Design review I5 / I-4: no payment may be initiated from an impersonation session.
  rejectImpersonated,
  paymentLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    let rollbackContext: { orderId: string; storeId: string; sessionId: string } | null = null;
    // Set the moment the gateway ACCEPTS an invoice, cleared with the rollback
    // once the recording transaction COMMITs. Still set in the catch = the
    // provider holds a live invoice whose Payment row never became durable
    // (issue 2360).
    let acceptedInvoice: OrphanedProviderInvoice | null = null;

    try {
      const data = createPaymentSchema.parse(req.body);

      // Order ownership check supporting both signed-in customers and
      // guest checkout:
      //
      //   - Signed-in customer (req.user.role === 'customer'): the
      //     order's customerId must match req.user.userId.
      //   - Guest (no auth, or admin token leaking through): the order
      //     has customerId=null. We require the orderId itself, which
      //     is a v4 UUID — practically unguessable, and the storefront
      //     just got it back from /public/orders so any legitimate
      //     payer has it.
      //
      // Admin/super_admin cookies that bleed through from the same
      // browser fall into the guest branch because the customer-leak
      // guard on /public/orders already wrote customerId=null on the
      // order they're now paying for.
      const isCustomer = req.user?.role === 'customer';
      // The store is not known yet: it is resolved from the order id through the
      // SECURITY DEFINER lookup (strict RLS shows a contextless read nothing), then
      // every read happens inside that store's scope.
      const orderStoreId = await getOrderStoreId(data.orderId);
      const order = orderStoreId
        ? await readOrderForPayment(
            orderStoreId,
            isCustomer
              ? { id: data.orderId, customerId: req.user!.userId }
              : { id: data.orderId, customerId: null }
          )
        : null;

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      // Idempotent create (adversarial audit P2): this route used to have NO
      // existing-payment guard — every COD replay re-added the COD fee to
      // `order.total` and minted another `cod_pending` row (a plain
      // double-click corrupted real orders), and every online replay minted
      // another live gateway invoice the customer could ALSO pay (undetected
      // double capture). Terminal-failure payments (failed/cancelled/expired)
      // are excluded so a legitimate retry after a failed attempt still works.
      const existingPayment = await readPayment(order.storeId, db =>
        db.payment.findFirst({
          where: {
            orderId: order.id,
            status: { notIn: ['failed', 'cancelled', 'expired'] },
          },
          orderBy: { createdAt: 'desc' },
        })
      );
      if (existingPayment) {
        const settled = ['completed', 'refunded', 'partially_refunded', 'disputed'].includes(
          existingPayment.status
        );
        if (settled) {
          res.status(409).json({
            success: false,
            error: {
              code: 'ORDER_ALREADY_PAID',
              message: 'This order already has a settled payment',
            },
          });
          return;
        }
        if (existingPayment.provider === 'cod' && data.provider === 'cod') {
          await assertPaymentRoutable(order.storeId, existingPayment.id);
          // Replay the original COD response — the fee was applied on the
          // first call and must not stack. (A Durable Object COD row carries the same metadata.)
          const meta = (existingPayment.metadata ?? {}) as Record<string, unknown>;
          res.json({
            success: true,
            data: {
              transactionId: existingPayment.id,
              provider: 'cod',
              cod: true,
              codFee: typeof meta.codFee === 'number' ? meta.codFee : 0,
            },
          });
          return;
        }
        if (existingPayment.provider === 'instapay' && data.provider === 'instapay') {
          await assertPaymentRoutable(order.storeId, existingPayment.id);
          // Same InstaPay hold, same instructions: nothing is created twice.
          const view = await InstapayService.getInstructions(order.storeId, order.id);
          res.json({
            success: true,
            data: {
              transactionId: existingPayment.id,
              provider: 'instapay',
              instapay: view.instructions,
            },
          });
          return;
        }
        const existingInstruction = (
          (existingPayment.metadata ?? {}) as { instruction?: { kind?: string } }
        ).instruction;
        if (
          existingPayment.provider === data.provider &&
          (existingPayment.paymentUrl || existingInstruction)
        ) {
          // the live invoice is handed out again only when its gateway reference routes (a webhook must find this store)
          await assertPaymentRoutable(order.storeId, existingPayment.id);
          // Same provider, live invoice already minted — hand back the
          // existing paymentUrl (or Fawry reference code) instead of creating a second invoice.
          res.json({
            success: true,
            data: {
              transactionId: existingPayment.transactionId ?? existingPayment.id,
              paymentUrl: existingPayment.paymentUrl ?? '',
              ...(existingInstruction ? { instruction: existingInstruction } : {}),
              provider: existingPayment.provider,
            },
          });
          return;
        }
        // Different provider (customer switched payment method mid-checkout)
        // or a legacy pending row without a stored paymentUrl — fall through
        // and create. The abandoned pending invoice is driven terminal by the
        // daily auto-cancel reconciler.
      }

      // Ruling SHARIA-GOLD-1: the second server-side gate. An order priced from gold lines can only be paid
      // up front online unless the store allows COD / installments; the provider and the method the shopper
      // picked are judged here even if the checkout was bypassed.
      const orderHasGold = order.items.some(
        (i: { goldSnapshot?: unknown }) => i.goldSnapshot !== null && i.goldSnapshot !== undefined
      );
      let goldPrepaidOnly = false;
      if (orderHasGold) {
        const storeRow = await withStore(order.storeId, tx =>
          tx.store.findUnique({ where: { id: order.storeId }, select: { settings: true } })
        );
        goldPrepaidOnly = !goldAllowsDeferredPayment(storeRow?.settings);
        assertGoldPaymentAllowed({
          hasGold: true,
          storeSettings: storeRow?.settings,
          provider: data.provider,
          // Fawry's adapter defaults to settings.methods[0] (`payatfawry`, a reference paid at an outlet later) when no method is sent.
          method: data.method ?? (data.provider === 'fawry' ? 'payatfawry' : undefined),
        });
      }

      // Customer wallet (D1): `order.total` is the order VALUE; the part paid
      // from the wallet at checkout is `order.walletAmount`, and only the
      // remainder is ever charged here. 0 for every order that did not use the
      // wallet, so both amounts below are exactly what they always were.
      const walletAmount = order.walletAmount ?? 0;
      // An order the wallet paid in full was created paid and never needs a
      // gateway or courier collection. Refuse rather than mint an invoice for
      // money that has already been paid (a replayed or stale checkout).
      if (walletAmount > 0 && order.total - walletAmount <= 0) {
        res.status(409).json({
          success: false,
          error: {
            code: 'ORDER_ALREADY_PAID',
            message: 'This order was paid in full from the customer wallet',
          },
        });
        return;
      }

      // The order-creation transaction alone owns manual-hold admission.
      // A gateway order cannot opt into an indefinite COD hold after bypassing
      // that transaction's cap. Existing same-provider live retries returned
      // above remain compatible for legacy orders without the marker.
      if ((data.provider === 'cod' || data.provider === 'instapay') && !order.manualHoldAdmitted) {
        res.status(409).json({
          success: false,
          error: {
            code: 'MANUAL_HOLD_NOT_ADMITTED',
            message: 'Go back to checkout and choose this payment method when placing a new order.',
          },
        });
        return;
      }

      // Set rollback context for the catch block. We only roll back if there's
      // no payment yet — paid orders don't get auto-cancelled by retry attempts.
      const sessionIdHeader = (req.headers['x-session-id'] as string | undefined) ?? '';
      if (sessionIdHeader && order.status === 'pending') {
        rollbackContext = {
          orderId: order.id,
          storeId: order.storeId,
          sessionId: sessionIdHeader,
        };
      }

      // COMMIT BEFORE RESPOND. Every shape below RETURNS the response instead of
      // sending it, and the send happens after Postgres has COMMITted. `payments/*`
      // is mounted bare (no `tenantContext`), so it does not get the middleware
      // lifecycle in `middleware/request-transaction.ts`; it has to do this itself.
      //
      // Measured (2026-09-08, local Postgres): the 200 reached the client
      // 0.376ms BEFORE its own COMMIT landed, so a caller that read the payment
      // row back immediately could miss it — on the money path, where a 200
      // means "your payment is recorded". Same defect class as #1596. Do not
      // move a `res.*` call back inside a transaction callback.
      let paymentResponse: { status: number; body: Record<string, unknown> };
      // Work that may only run once the transaction above COMMITs (the InstaPay
      // merchant notification). This router is mounted bare, so it drains its own queue.
      const afterCommit: Array<{ name: string; task: () => Promise<unknown> }> = [];

      if (data.provider === 'cod' || data.provider === 'instapay') {
        // No network: one short tenant transaction.
        paymentResponse = await runInStoreCtx<{
          status: number;
          body: Record<string, unknown>;
        }>(order.storeId, async () => {
          // ==========================================
          // InstaPay — manual transfer, merchant confirms
          // ==========================================
          if (data.provider === 'instapay') {
            const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
            const { payment, instructions, created } = await InstapayService.initiate({
              storeId: order.storeId,
              order: {
                id: order.id,
                orderNumber: order.orderNumber,
                total: order.total,
                walletAmount,
                currency: order.currency,
                status: order.status,
              },
              customer: {
                name:
                  `${order.customer?.firstName ?? shipping.firstName ?? ''} ${order.customer?.lastName ?? shipping.lastName ?? ''}`.trim() ||
                  'Customer',
                email: order.customer?.email || shipping.email || '',
                phone: shipping.phone || undefined,
              },
              userId: req.user?.userId ?? null,
              postCommit: (name, task) => afterCommit.push({ name, task }),
            });
            if (created) {
              await auditLog({
                action: 'payment.created',
                userId: req.user?.userId,
                resourceType: 'payment',
                resourceId: payment.id,
                details: {
                  orderId: order.id,
                  amount: instructions.amountMinor,
                  provider: 'instapay',
                  ...(walletAmount > 0 ? { walletAmount } : {}),
                },
                ip: req.ip,
                userAgent: req.headers['user-agent'],
              });
            }
            return {
              status: 200,
              body: {
                success: true,
                data: { transactionId: payment.id, provider: 'instapay', instapay: instructions },
              },
            };
          }

          // ==========================================
          // COD (Cash on Delivery) — skip payment gateway
          // ==========================================
          // Look up COD config for fee
          // The store's own COD row only (no platform-level row exists for the app role, R-EBDA-007).
          const codConfig = await (
            await storeDb(order.storeId)
          ).paymentConfig.findFirst({
            where: { storeId: order.storeId, provider: 'cod', isEnabled: true },
          });

          if (!codConfig) {
            if (rollbackContext) {
              await OrderService.rollbackForPaymentFailure(
                rollbackContext.storeId,
                rollbackContext.orderId,
                rollbackContext.sessionId
              ).catch(err =>
                logger.error(
                  { err, ...rollbackContext },
                  'Order rollback failed (cod-not-available)'
                )
              );
            }
            return {
              status: 400,
              body: {
                success: false,
                error: {
                  code: 'COD_NOT_AVAILABLE',
                  message: 'Cash on Delivery is not available for this store',
                },
              },
            };
          }

          // The COD fee was quoted at checkout and frozen on the order at
          // creation (ruling MONEYB-3) — it is already inside `order.total`,
          // so nothing is added here and a replay can never stack it. An order
          // that was NOT priced for COD (created for another method) while the
          // store charges a COD fee is refused: charging a fee the shopper was
          // never shown is the defect this replaced. A prior COD payment row
          // means a replay (or a legacy order whose fee was folded in then).
          const priorCodPayment = await (
            await storeDb(order.storeId)
          ).payment.findFirst({
            where: { orderId: order.id, provider: 'cod' },
            select: { id: true },
          });
          const frozenFee = order.codFee;
          if (!priorCodPayment && frozenFee === 0) {
            const quote = codFeeForOrder(
              { subtotal: order.subtotal, discount: order.discount, shipping: order.shipping },
              codFeeConfigFromRow(codConfig)
            );
            if (quote > 0) {
              if (rollbackContext) {
                await OrderService.rollbackForPaymentFailure(
                  rollbackContext.storeId,
                  rollbackContext.orderId,
                  rollbackContext.sessionId
                ).catch(err =>
                  logger.error(
                    { err, ...rollbackContext },
                    'Order rollback failed (cod-not-quoted)'
                  )
                );
              }
              return {
                status: 409,
                body: {
                  success: false,
                  error: {
                    code: 'COD_FEE_NOT_QUOTED',
                    message:
                      'This order was not priced for cash on delivery. Go back to checkout and choose cash on delivery there.',
                  },
                },
              };
            }
          }
          const codFee = frozenFee;
          const collectAmount = codCollectMinor(order.total, walletAmount);
          // The provider-shaped COD adapter validates the charge (positive integer
          // piastres, EGP) and builds the instruction; no network.
          await codProvider.createPayment(
            {
              orderId: order.id,
              orderNumber: order.orderNumber,
              amountMinor: collectAmount,
              currency: order.currency as 'EGP',
              customer: { name: '', email: '' },
              returnUrls: { success: '', failure: '' },
              idempotencyKey: `${order.id}:cod`,
            },
            { mode: 'live' }
          );

          const codMeta = {
            codFee,
            originalTotal: order.total - codFee,
            ...(walletAmount > 0 ? { walletAmount } : {}),
          };
          // The row + its `created` audit event (on a Durable Object store: ONE section, an open COD row is reused).
          // NOT disarming the rollback here (issue 2306): on Postgres this runs inside the wrap's transaction and the row is
          // durable only once it COMMITs; the rollback context is cleared after `runInStoreCtx` resolves.
          const payment = await PaymentService.recordCodPayment({
            storeId: order.storeId,
            orderId: order.id,
            amount: collectAmount,
            currency: order.currency,
            metadata: codMeta,
            userId: req.user?.userId ?? null,
          });

          // a COD replay that raced past the read above got the SAME row back: no second "created" audit row (review M-5)
          if (!payment.replayed)
            await auditLog({
              action: 'payment.created',
              // Guest checkout: req.user is undefined, audit log accepts that.
              userId: req.user?.userId,
              resourceType: 'payment',
              resourceId: payment.id,
              details: {
                orderId: order.id,
                amount: collectAmount,
                codFee,
                provider: 'cod',
                ...(walletAmount > 0 ? { walletAmount } : {}),
              },
              ip: req.ip,
              userAgent: req.headers['user-agent'],
            });

          return {
            status: 200,
            body: {
              success: true,
              data: {
                transactionId: payment.id,
                provider: 'cod',
                cod: true,
                codFee,
              },
            },
          };
        });
      } else {
        // ==========================================
        // Online payment providers (Paymob, Kashier, Fawry)
        // ==========================================

        // Resolve the correct storefront URL for payment callbacks
        const storefrontBaseUrl = order.store ? storefrontOrigin(order.store) : config.webUrl;

        // Card-testing guard (SP5 task 4): per-store / per-IP attempt budgets and
        // the per-session decline block. Online providers only — the COD/InstaPay
        // branch above never reaches here, so they are never counted or blocked. A
        // refusal is a 429 AppError: the catch below rolls the pending order back
        // (cart + stock restored) exactly as for a failed provider call. Redis only:
        // no transaction is open.
        await CardTestingGuard.assertAllowed({
          storeId: order.storeId,
          orderId: order.id,
          // No explicit provider = the store's default ONLINE one (never cod here).
          provider: data.provider ?? 'default',
          ip: req.ip,
          sessionId: sessionIdHeader,
        });

        const providerName =
          data.provider ?? (await PaymentService.getDefaultProvider(order.storeId));
        if (!providerName) {
          throw new AppError(500, 'PAYMENT_NOT_CONFIGURED', 'No payment providers configured');
        }
        // Outage isolation (Review Focus 5): a method whose circuit is open fails
        // fast instead of making the customer wait out another timeout. Only THIS
        // method is affected; the checkout still offers COD / InstaPay / the rest.
        if (!isProviderAvailable(order.storeId, providerName)) {
          throw new AppError(
            503,
            'PAYMENT_METHOD_UNAVAILABLE',
            'This payment method is temporarily unavailable. Please choose another method.'
          );
        }

        const paymentRequest = {
          orderId: order.id,
          orderNumber: order.orderNumber,
          // Amount due — see the wallet note above. === order.total when the
          // wallet was not used.
          amount: order.total - walletAmount,
          currency: order.currency as Currency,
          customer: (() => {
            // Guest checkout has order.customer = null but the checkout
            // form's name/email/phone live on order.shippingAddress (JSON).
            // Gateways may reject empty emails (400 "must be a
            // valid email") so always fall through to the shippingAddress
            // values before defaulting to a blank — guests are the common
            // case on storefronts, not the exception.
            const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
            return {
              // Stable id so providers hashing the customer for 3D-Secure /
              // fraud scoring see a consistent value across retries.
              id: req.user?.userId ?? `guest-${order.id}`,
              name:
                `${order.customer?.firstName ?? shipping.firstName ?? ''} ${order.customer?.lastName ?? shipping.lastName ?? ''}`.trim() ||
                'Customer',
              email: order.customer?.email || shipping.email || '',
              phone: shipping.phone || undefined,
            };
          })(),
          items: buildPaymentLineItems(order.items),
          // Resolve relative paths against the order's storefront base URL so
          // payment providers always receive an absolute URL that points back
          // at the correct tenant domain (custom domain or platform slug).
          callbackUrl: data.successUrl
            ? data.successUrl.startsWith('/')
              ? `${storefrontBaseUrl}${data.successUrl}`
              : data.successUrl
            : `${storefrontBaseUrl}/checkout/success`,
          errorUrl: data.errorUrl
            ? data.errorUrl.startsWith('/')
              ? `${storefrontBaseUrl}${data.errorUrl}`
              : data.errorUrl
            : `${storefrontBaseUrl}/checkout/error`,
          webhookUrl: paymentWebhookUrl(providerName, order.storeId),
          ...(data.method || goldPrepaidOnly
            ? {
                metadata: {
                  ...(data.method ? { method: data.method } : {}),
                  // Gold, prepaid only: a gateway page that offers every method must leave installments out.
                  ...(goldPrepaidOnly ? { excludeBnpl: 'true' } : {}),
                },
              }
            : {}),
        };

        // THE PROVIDER CALL — no transaction is open. It throws on provider-not-
        // configured / provider-error / outage / validation-failure — the catch
        // block at the end of this handler runs the rollback so the customer's
        // cart is restored and inventory isn't drained by a failed attempt.
        const { providerName: acceptedBy, response: result } =
          await PaymentService.requestProviderPayment(paymentRequest, providerName, order.storeId);

        // Provider accepted — the invoice is live at the gateway from here, and
        // the rollback context stays armed until the Payment row is durable (issue
        // 2306): a failure to record it must roll the order back in the outer
        // catch. That rollback does NOT reach the gateway: the invoice stays live,
        // so the catch raises a P1 naming it for an operator to void (issue 2360,
        // ruling PAY-ORPH-1). The client never receives this paymentUrl.
        acceptedInvoice = {
          storeId: order.storeId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          provider: result.provider,
          transactionId: result.transactionId,
          amount: order.total - walletAmount,
          currency: order.currency,
          source: 'checkout',
        };

        // Short transaction to record: the Payment row + its audit event + the audit log.
        paymentResponse = await runInStoreCtx<{
          status: number;
          body: Record<string, unknown>;
        }>(order.storeId, async () => {
          await PaymentService.recordProviderPayment(
            acceptedBy,
            paymentRequest,
            result,
            order.storeId
          );

          await auditLog({
            action: 'payment.created',
            userId: req.user?.userId,
            resourceType: 'payment',
            resourceId: result.transactionId,
            details: {
              orderId: order.id,
              amount: order.total - walletAmount,
              provider: result.provider,
              ...(walletAmount > 0 ? { walletAmount } : {}),
            },
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });

          return {
            status: 200,
            body: {
              success: true,
              data: {
                transactionId: result.transactionId,
                paymentUrl: result.paymentUrl,
                // What the customer does next when it is not a redirect (a Fawry reference code).
                instruction: result.instruction,
                provider: result.provider,
                paymentMethods: result.paymentMethods,
              },
            },
          };
        });
      }

      // COMMITTED. The payment (or the COD-unavailable rollback the callback
      // already ran) is durable, so the compensating rollback is disarmed only
      // now — never inside the wrap, where a failed COMMIT would have left a
      // pending order with stock decremented, the cart cleared and no Payment
      // row (issue 2306).
      rollbackContext = null;
      acceptedInvoice = null;
      await runPostCommit(afterCommit);

      // Only now do the bytes go out, so a 200 here means the payment row is
      // durable and visible to every other connection.
      res.status(paymentResponse.status).json(paymentResponse.body);
    } catch (error) {
      // Compensating rollback: if the order was committed (cart cleared,
      // inventory decremented) but the payment step failed, undo all of that
      // so the customer can retry without losing their cart or seeing stock
      // drain on every attempt.
      if (rollbackContext) {
        // Its own tenant wrap: this catch sits OUTSIDE the request's
        // runInTenantContext (the /payments mount has no tenantContext), so
        // under ebda_app the rollback would read no rows and do nothing
        // (PR 2301 audit, same class as the MCP place_order rollbacks).
        const rb = rollbackContext;
        await runInStoreCtx(rb.storeId, () =>
          OrderService.rollbackForPaymentFailure(rb.storeId, rb.orderId, rb.sessionId)
        ).catch(rbErr =>
          logger.error({ err: rbErr, ...rollbackContext }, 'Order rollback failed in catch block')
        );
      }
      // Independent of the rollback: an order that was not rolled back (no
      // session header) still has no Payment row behind a live invoice.
      if (acceptedInvoice) await alertOrphanedProviderInvoice(acceptedInvoice);
      // A provider outage (or a gateway the merchant has not finished setting up) reaches the client
      // as a 503 with a code the checkout maps to "choose another method"; a gateway that REFUSED
      // the request is a 502 with a generic message (the gateway's own reason stays in the log).
      // Nothing here is the customer's to fix, so none of it is a 500 "internal error".
      if (
        error instanceof PaymentProviderError &&
        (error.isOutage || error.code === 'PROVIDER_MISCONFIGURED')
      ) {
        next(
          new AppError(
            503,
            'PAYMENT_METHOD_UNAVAILABLE',
            'This payment method is temporarily unavailable. Please choose another method.'
          )
        );
        return;
      }
      if (error instanceof PaymentProviderError) {
        logger.warn(
          { err: error, orderId: req.body?.orderId },
          '[PAYMENT] provider refused create'
        );
        next(
          new AppError(
            502,
            'PAYMENT_PROVIDER_ERROR',
            'The payment provider could not start this payment. Please try again or choose another method.'
          )
        );
        return;
      }
      next(error);
    }
  }
);

/**
 * GET /payments/instapay/:orderId
 * The customer's view of an InstaPay order: the merchant's handle/phone, the exact
 * amount in piastres, the reference to quote, the deadline and its status. Public
 * by order id (an unguessable v4 UUID, like /payments/create).
 */
router.get(
  '/instapay/:orderId',
  paymentLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = z.string().uuid().parse(req.params.orderId);
      const storeId = await getOrderStoreId(orderId);
      if (!storeId) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      const view = await InstapayService.getInstructions(storeId, orderId);
      // SEC-15: the receipt id (which opens the receipt poll) only with the order's view token.
      const withToken = requestHoldsOrderViewToken(req, orderId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.vary('X-Order-View-Token');
      res.json({
        success: true,
        data:
          withToken || !view.proof ? view : { ...view, proof: { ...view.proof, receiptId: null } },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payments/instapay/:orderId/reference — RETIRED (money batch A): a typed
 * reference alone is no longer proof. The shopper uploads the receipt screenshot.
 */
router.post('/instapay/:orderId/reference', paymentLimiter, (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: { code: 'RECEIPT_REQUIRED', message: 'Upload the InstaPay receipt screenshot' },
  });
});

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INSTAPAY_RECEIPT_MAX_BYTES, files: 1 },
});

/**
 * POST /payments/instapay/:orderId/receipt — the shopper uploads the InstaPay receipt
 * screenshot (multipart `file`). Guarded by the order's signed view token (TEN-5). Rate-limited per IP and capped per order; stored in the PRIVATE
 * bucket only; the AI read is queued and the shopper polls GET .../receipt/:id.
 */
router.post(
  '/instapay/:orderId/receipt',
  optionalAuthenticate,
  rejectImpersonated,
  paymentLimiter,
  requireInstapayOrderAccess, // TEN-5 + INSTAPAY-UPLOAD-1: view token OR the owning signed-in customer; refuse BEFORE multer buffers the file
  uploadLimiter,
  dailyUploadLimiter,
  receiptUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = z.string().uuid().parse(req.params.orderId);
      if (!req.file) throw new AppError(400, 'NO_FILE', 'No file uploaded. Send field name: file');
      const storeId = await getOrderStoreId(orderId);
      if (!storeId) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      const receipt = await InstapayService.uploadReceipt(storeId, orderId, req.file.buffer);
      res.status(201).json({ success: true, data: { receipt } });
    } catch (error) {
      next(error);
    }
  }
);

/** GET /payments/instapay/:orderId/receipt/:receiptId — the AI's pre-filled fields (poll). */
router.get(
  '/instapay/:orderId/receipt/:receiptId',
  paymentLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = z.string().uuid().parse(req.params.orderId);
      const receiptId = z.string().uuid().parse(req.params.receiptId);
      const storeId = await getOrderStoreId(orderId);
      if (!storeId) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      const receipt = await InstapayService.getReceipt(storeId, orderId, receiptId);
      // SEC-15: the payer's name / address / mobile / bank only with the order's view token.
      res.json({
        success: true,
        data: {
          receipt: requestHoldsOrderViewToken(req, orderId)
            ? receipt
            : maskReceiptPayerPii(receipt),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payments/instapay/:orderId/receipt/:receiptId/submit — the shopper's checked
 * fields. The store owner reviews; a duplicate transfer reference anywhere is refused
 * (409 DUPLICATE_REFERENCE). Freezes the hold: the order is not auto-cancelled while
 * the store reviews.
 */
router.post(
  '/instapay/:orderId/receipt/:receiptId/submit',
  optionalAuthenticate,
  rejectImpersonated,
  paymentLimiter,
  requireInstapayOrderAccess, // TEN-5 + INSTAPAY-UPLOAD-1
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = z.string().uuid().parse(req.params.orderId);
      const receiptId = z.string().uuid().parse(req.params.receiptId);
      const fields = instapayReceiptFieldsSchema.parse(req.body);
      const storeId = await getOrderStoreId(orderId);
      if (!storeId) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      const receipt = await InstapayService.submitReceipt({ storeId, orderId, receiptId, fields });
      res.status(201).json({ success: true, data: { receipt } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/status/:transactionId
 * Get payment status
 */
router.get(
  '/status/:transactionId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { transactionId } = req.params;
      const user = getAuthUser(req);
      const provider = req.query.provider as PaymentProvider | undefined;
      const notFound = () =>
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment not found' },
        });

      // Strict RLS: a contextless read sees nothing, so the owning store is resolved from the
      // provider reference through the definer, and every read below runs inside that store.
      const statusStoreId = await resolveStoreFromWebhookRef({
        transactionId,
        // Only the gateways share reference strings across providers; `cod` / `instapay` have no gateway reference,
        // and a caller's ?provider= for them must not turn a found payment into a 404 (Ruling ITEST-14).
        provider:
          provider === 'paymob' || provider === 'kashier' || provider === 'fawry'
            ? provider
            : undefined,
      });
      if (!statusStoreId) {
        notFound();
        return;
      }

      // Verify authorization: customers can only see their own payments,
      // store_admins can only see payments from their stores.
      // Read through the store's own backend (NEON-ZERO: a Durable Object store has no Postgres row). The order is found
      // from the payment, then the caller must own it (customer) or own its store (store_admin).
      const allowed = await readPayment(statusStoreId, async db => {
        if (user.role === 'super_admin') return true; // super admin can view any payment
        const pay = await db.payment.findFirst({
          where: { transactionId },
          select: { orderId: true },
        });
        if (!pay) return false;
        const order = await db.order.findFirst({
          where: { id: pay.orderId, storeId: statusStoreId },
          select: { customerId: true },
        });
        if (!order) return false;
        if (user.role === 'store_admin') {
          // Store admin must own the store the order belongs to
          const store = await db.store.findUnique({
            where: { id: statusStoreId },
            select: { ownerId: true },
          });
          return store?.ownerId === user.userId;
        }
        // Customer: must own the order
        return order.customerId === user.userId;
      });
      if (!allowed) {
        notFound();
        return;
      }

      const status = await withStore(statusStoreId, () =>
        PaymentService.getPaymentStatus(transactionId, provider, statusStoreId)
      );

      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payments/refund
 * Refund a payment (admin only)
 */
router.post(
  '/refund',
  authenticate,
  // BE:S-2 / S-11 (Ruling FP-3): money out is never done from an impersonated session; super_admin needs MFA.
  requireMfaEnrolled,
  rejectImpersonated,
  requirePermission('orders:refund'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = refundSchema.parse(req.body);
      const user = getAuthUser(req);
      // Same Idempotency-Key -> the first answer again, never a second refund (review M-8, Ruling NZ-MONEY-3). The key is
      // scoped to the caller and the transaction, so another payment or another user never collides with it.
      const idem = idempotencyKeyOf(req.header('idempotency-key'));
      const out = await withIdempotencyKey(
        `refund:${user.userId}:${data.transactionId}`,
        idem,
        () => refundOnce(data, user, req),
        refundMayHaveExecuted
      );
      res.json({ success: true, data: { refund: out.value } });
    } catch (error) {
      next(error);
    }
  }
);

/** The body of POST /payments/refund: the refund the provider made (a not-found is a thrown 404, which frees the key). */
async function refundOnce(
  data: z.infer<typeof refundSchema>,
  user: ReturnType<typeof getAuthUser>,
  req: Request
) {
  // Bootstrap lookup OUTSIDE runInTenantContext: the store is not known yet and a
  // contextless read shows nothing under strict RLS, so the definer maps the provider
  // reference to its store and the payment is read inside that store. Ownership follows.
  const resolvedRefundStore = await resolveStoreFromWebhookRef({
    transactionId: data.transactionId,
    provider: data.provider,
  });
  // the store's own backend (NEON-ZERO); the payment's store IS the resolved one
  const paymentRow = resolvedRefundStore
    ? await readPayment(resolvedRefundStore, db =>
        db.payment.findFirst({
          where: { transactionId: data.transactionId },
          include: { order: { select: { id: true, storeId: true } } },
        })
      )
    : null;
  if (paymentRow && paymentRow.order.storeId !== resolvedRefundStore) {
    throw new AppError(404, 'NOT_FOUND', 'Payment not found');
  }
  if (!paymentRow) {
    throw new AppError(404, 'NOT_FOUND', 'Payment not found');
  }
  // BE:S-12: ownership for EVERY non-platform role. It used to check `store_admin` only, so a staff member holding
  // `orders:refund` (on any store) passed with no membership check at all.
  if (user.role !== 'super_admin') {
    const access = await checkStoreAccess(paymentRow.order.storeId, user);
    if (!access.ok) {
      throw new AppError(404, 'NOT_FOUND', 'Payment not found');
    }
  }

  const refundStoreId = paymentRow.order.storeId;

  // Compensating-rollback order (M-128, Ruling M128-1): INTENT row first, on its own transaction, then the money,
  // then the OUTCOME row. The intent is the durable proof an admin asked for this refund, so a crash or a failed
  // outcome write after the money moved leaves a trail and never an unexplained refund. No intent row, no money:
  // the write failing refuses the refund before anything leaves the building.
  const auditBase = {
    userId: user.userId,
    storeId: refundStoreId,
    resourceType: 'payment',
    resourceId: data.transactionId,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
  try {
    await runInStoreCtx(refundStoreId, () =>
      auditLogStrict({
        ...auditBase,
        action: 'payment.refund_requested',
        details: { amount: data.amount ?? null, reason: data.reason || null },
      })
    );
  } catch (err) {
    logger.error(
      { err, paymentId: paymentRow.id },
      '[payments] refund refused: intent audit row not written'
    );
    throw new AppError(
      503,
      'AUDIT_UNAVAILABLE',
      'تعذّر تسجيل عملية الاسترداد، فلم يتم تحويل أي مبلغ. حاول مرة أخرى بعد قليل.'
    );
  }

  // The money step. PaymentService.refund commits its own claim / completion on their own transactions, so by the
  // time this returns the refund HAS happened at the provider; nothing below may turn that into an error.
  let refund: Awaited<ReturnType<typeof PaymentService.refund>>;
  try {
    refund = await runInStoreCtx(refundStoreId, () =>
      // The store is named (and the provider when the caller gave one): a Durable Object store's refund is the claim /
      // completion sections on its DO (`refundOnDo`); without it the service would look the payment up in Postgres.
      PaymentService.refund(
        {
          transactionId: data.transactionId,
          amount: data.amount,
          reason: data.reason,
        },
        data.provider,
        refundStoreId
      )
    );
  } catch (err) {
    // The compensating row: the intent is not left dangling. Best effort; the provider outcome (maybe executed)
    // is the claim-stuck sweep's job, not this write's.
    void runInStoreCtx(refundStoreId, () =>
      auditLogStrict({
        ...auditBase,
        action: 'payment.refund_failed',
        details: { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' },
      })
    ).catch(() => undefined);
    throw err;
  }

  // Each trail write is its OWN transaction and its own failure: neither can turn a refund that left the building
  // into a 5xx, and one failing never takes the other with it. The money fact itself is the payment row plus its
  // refund_initiated / refund_completed events, written by the service above.
  const alertLost = (what: string, err: unknown) => {
    logger.error(
      { err, paymentId: paymentRow.id, refundId: refund.refundId },
      `[payments] refund committed but its ${what} failed`
    );
    void sendAlert({
      level: 'p1',
      scope: 'store',
      store: { id: refundStoreId, name: refundStoreId },
      source: 'payment.refund.audit_failed',
      title: 'payment.refund.audit_failed',
      body: `Refund ${refund.refundId} of ${refund.amount} piastres on payment ${paymentRow.id} was made; its ${what} could not be written (the intent row and the payment events are intact).`,
      context: { paymentId: paymentRow.id, refundId: refund.refundId, amount: refund.amount, what },
    }).catch(() => undefined);
  };
  const outcomeEntry = {
    ...auditBase,
    resourceId: refund.transactionId,
    action: 'payment.refunded',
    details: { refundId: refund.refundId, amount: refund.amount, reason: data.reason || null },
  };
  await runInStoreCtx(refundStoreId, () => auditLogStrict(outcomeEntry))
    .catch(() => runInStoreCtx(refundStoreId, () => auditLogStrict(outcomeEntry)))
    .catch(err => alertLost('outcome audit row', err));
  await runInStoreCtx(refundStoreId, async () => {
    const after = await (
      await storeDb(refundStoreId)
    ).payment.findUnique({
      where: { id: paymentRow.id },
      select: { status: true },
    });
    // on a Durable Object store the row is appended there (`paymentEventRecord`); Postgres joins this scope
    await recordPaymentEventForStore({
      paymentId: paymentRow.id,
      storeId: refundStoreId,
      orderId: paymentRow.orderId,
      eventType: 'refund',
      fromStatus: paymentRow.status,
      toStatus:
        after?.status ??
        ((paymentRow.refundedAmount ?? 0) + refund.amount >= paymentRow.amount
          ? 'refunded'
          : 'partially_refunded'),
      provider: paymentRow.provider,
      triggeredByUserId: user.userId,
      details: {
        refundId: refund.refundId,
        amount: refund.amount,
        reason: data.reason ?? null,
        initiatedBy: user.role,
      },
    });
  }).catch(err => alertLost('payment event row', err));

  return refund;
}

/**
 * POST /payments/retry/:paymentId
 * Retry a failed payment
 */
router.post(
  '/retry/:paymentId',
  authenticate,
  rejectImpersonated,
  paymentLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { paymentId } = req.params;
      const user = getAuthUser(req);
      const provider = retryBodySchema.parse(req.body ?? {}).provider as
        | PaymentProvider
        | undefined;

      // The store is not known yet (strict RLS shows a contextless read nothing): a definer
      // maps the payment id to its store, then the ownership check reads inside that scope.
      const paymentStoreId = await getPaymentStoreId(paymentId);
      const payment = paymentStoreId
        ? await readPayment(paymentStoreId, db =>
            db.payment.findUnique({
              where: { id: paymentId },
              include: { order: true },
            })
          )
        : null;

      if (!payment || payment.order.customerId !== user.userId) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment not found' },
        });
        return;
      }

      // A retry is another online attempt: same card-testing budgets as /create.
      await CardTestingGuard.assertAllowed({
        storeId: payment.order.storeId,
        orderId: payment.order.id,
        provider: provider ?? payment.provider,
        ip: req.ip,
        sessionId: req.headers['x-session-id'] as string | undefined,
      });

      // No request transaction: the service reads in a short scope, calls the gateway with
      // nothing held, then records in a short transaction.
      const result = await PaymentService.retryPayment(paymentId, provider, payment.order.storeId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/order/:orderId
 * Get payment for an order
 */
router.get(
  '/order/:orderId',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = req.params;
      const user = getAuthUser(req);

      // Verify authorization based on role — derive access from the order itself. The order's
      // store comes from the definer (strict RLS hides a contextless read), then every read
      // runs inside that store.
      const orderStoreId = await getOrderStoreId(orderId);
      const order = orderStoreId
        ? await readPayment(orderStoreId, async db => {
            const o = await db.order.findFirst({ where: { id: orderId, storeId: orderStoreId } });
            if (!o) return null;
            if (user.role === 'super_admin') return o;
            if (user.role === 'store_admin') {
              // Store admin can only see orders from stores they own
              const store = await db.store.findUnique({
                where: { id: orderStoreId },
                select: { ownerId: true },
              });
              return store?.ownerId === user.userId ? o : null;
            }
            // Customer: can only see their own orders
            return o.customerId === user.userId ? o : null;
          })
        : null;

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      const payment = await PaymentService.getPaymentByOrderId(orderId, order.storeId);

      res.json({
        success: true,
        data: { payment },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Payment Audit Log
// ==========================================

/**
 * GET /payments/:id/events
 * Returns the append-only `payment_events` rows for a payment, newest
 * first. Super-admin can read any store; store-admin can read only
 * payments scoped to a store they own.
 *
 * Access control: same precedent as POST /payments/refund — load the
 * payment with its store ownerId, then accept the request only when
 * the requester is super_admin or is the store owner.
 */
/** D1 twin of `resolvePaymentEventsStore`: unknown payment and denied access are the same "not found". */
async function resolvePaymentEventsStoreD1(
  user: { userId: string; role: string },
  paymentId: string
): Promise<{ storeId: string; paymentId: string } | null> {
  const storeId = await getPaymentStoreId(paymentId);
  if (!storeId) return null;
  const access = await checkStoreAccess(storeId, user);
  return access.ok ? { storeId, paymentId } : null;
}

router.get('/:id/events', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getAuthUser(req);
    const { id: paymentId } = req.params;

    // The payment's store is found by a GUARDED definer (an active super_admin, or the owner /
    // staff of that payment's store; anyone else sees "not found"), then the events are read
    // inside that store's scope. Under strict RLS a contextless read would see no row at all.
    // After the `access` cutover the Postgres definer's staff branch reads a frozen/emptied copy, so access is decided from
    // D1 instead: the payment's store by exact id, then the same gate every admin route uses (owner, live staff, super_admin).
    const owner = (await onAccessD1())
      ? await resolvePaymentEventsStoreD1(user, paymentId)
      : await resolvePaymentEventsStore({ actorUserId: user.userId, paymentId });
    if (!owner) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment not found' },
      });
      return;
    }

    const events = await readPayment(owner.storeId, db =>
      db.paymentEvent.findMany({
        where: { storeId: owner.storeId, paymentId: owner.paymentId },
        orderBy: { occurredAt: 'desc' },
        select: {
          id: true,
          eventType: true,
          fromStatus: true,
          toStatus: true,
          provider: true,
          // providerPayload is intentionally omitted from the LIST shape —
          // payloads can be large + may contain PII. The single-event
          // endpoint below returns it gated to super_admin.
          details: true,
          triggeredByUserId: true,
          occurredAt: true,
          createdAt: true,
        },
        take: 200,
      })
    );

    res.json({ success: true, data: { events } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /payments/events/:eventId/payload
 * Returns the raw provider_payload for a single payment_events row.
 * Super-admin only because raw payloads may contain customer PII +
 * provider-internal references we don't want to leak to store_admin
 * dashboards by default. The event's store is found by the same guarded definer.
 */
router.get(
  '/events/:eventId/payload',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getAuthUser(req);
      if (user.role !== 'super_admin') {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Super-admin only' },
        });
        return;
      }
      const { eventId } = req.params;
      // Ruling NZ-PG-2: after the `access` cutover the Postgres definer is gone; the caller is already a verified super_admin
      // (the role gate above), so the event's store is found by a primary-key probe of the stores' own DOs.
      const owner = (await onAccessD1())
        ? await (async () => {
            const storeId = await (
              await import('../lib/entity-store-fanout.js')
            ).entityStoreByFanout('payment_event', eventId);
            return storeId ? { storeId } : null;
          })()
        : await resolvePaymentEventsStore({ actorUserId: user.userId, eventId });
      const event = owner
        ? await readPayment(owner.storeId, db =>
            db.paymentEvent.findUnique({
              where: { id: eventId, storeId: owner.storeId },
              select: {
                id: true,
                paymentId: true,
                eventType: true,
                provider: true,
                providerPayload: true,
                occurredAt: true,
              },
            })
          )
        : null;
      if (!event) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Payment event not found' },
        });
        return;
      }
      res.json({ success: true, data: event });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
