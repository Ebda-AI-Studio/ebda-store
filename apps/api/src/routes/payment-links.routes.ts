/**
 * Merchant-Initiated Payment Links — Phase 7 (rewritten Phase 7.1).
 *
 * Lets a store admin send a customer a WhatsApp message containing a
 * one-tap hosted-checkout URL from the store's own gateway. Used for invoices, custom quotes,
 * or any out-of-band order.
 *
 * Flow:
 *   1. Validate input (phone, amount or items)
 *   2. Find-or-create a Customer row
 *   3. Create a draft Order (status=pending, paymentStatus=unpaid)
 *   4. Mint a payment link via PaymentService.createPayment (no request transaction)
 *   5. Send the hosted-checkout URL via the WBS paymentLink template
 *
 * Routes:
 *   POST /stores/:id/payment-links
 *     body: { customerPhone, items?: [{productId, quantity}],
 *             amountFils?, customerName?, language? }
 *
 * Note: OrderItem.productId is required+non-nullable in the schema.
 * Open-amount mode (no items) is not supported — callers must pass at
 * least one product item. The admin UI already exposes an amount-only
 * input; in that mode the frontend should be updated to require item
 * selection, but to avoid a breaking change we reject open-amount at
 * the API level with a clear error code.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { computeOrderAmounts, normalizePhoneForStorage, storefrontOrigin } from '@ebda/shared';
import { z } from 'zod';
import { hasTenantContext, prisma, withMoneyTx, type Prisma } from '@ebda/database';
import { config } from '../config';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { auditLog, writeLimiter } from '../middleware/security';
import { encryption } from '../services/encryption.service';
import { PriceResolver, wholesaleEntitledUncached } from '../services/price-resolver.service';
import { ANONYMOUS_BUYER } from '../lib/buyer-identity';
import { assertMoqSatisfied, priceSnapshot } from '../lib/order-pricing';
import { AppError } from '../middleware/error-handler';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { getAuthUser } from '../utils/store-helpers';
import { generateOrderNumber } from '../utils/order-number';
import { frozenTaxInvoiceFields, resolveActiveTaxRate } from '../lib/order-tax';
import { FiscalDocumentService } from '../services/fiscal-document.service';
import { EFFECTIVE_STOCK_SELECT, isOrderable } from '../lib/effective-inventory';
import { featureService } from '../services/feature.service';
import { assertOrderAllowed } from '../services/plan-limit.service';
import logger from '../lib/logger';
import { variantRequiredError } from '../lib/variant-required';
import type { Currency } from '../services/payment-providers/types';

import { minorToDecimalString, REGION } from '@ebda/shared';
import { paymentWebhookUrl } from '../services/payment-providers/webhook-url';
const router = Router({ mergeParams: true });

const bodySchema = z
  .object({
    // Customer's phone in E.164 format
    customerPhone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164 (e.g. +201012345678)'),
    customerName: z.string().min(1).max(100).optional(),
    // Items from the catalogue (productId references). Optional when an
    // extraAmount is provided — a payment link can be ALL custom charge
    // (e.g. service deposit, custom quote) with no catalogued items.
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          // Required for a product with variants (C-01: sold as one of its
          // variants, never the bare parent); validated below.
          variantId: z.string().uuid().optional(),
          quantity: z.number().int().min(1).max(99),
        })
      )
      .max(50)
      .optional(),
    // Out-of-catalogue charge in piastres. Baked into Order.total + persisted
    // as Order.extraAmount. Use for custom quotes, deposits, service fees
    // that don't map to a Product. Either items OR extraAmount (or both)
    // must be provided.
    extraAmountFils: z.number().int().min(0).max(100_000_000).optional(),
    extraAmountNote: z.string().max(200).optional(),
    // Override paymentLink template language (default = en)
    language: z.enum(['en', 'ar']).optional(),
  })
  .refine(
    d => (d.items && d.items.length > 0) || (d.extraAmountFils && d.extraAmountFils > 0),
    'Provide at least one item OR a non-zero extra amount.'
  );

router.post(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  // Sends the link through the WhatsApp Business API (WBS) — flagged OFF for
  // every store (WHATSAPP-OFF-1). The wa.me "share link" flow on the order
  // page is a different endpoint and does not depend on this flag.
  requireFeature('whatsapp'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const storeId = req.params.id;
    let draftOrderId: string | null = null;

    try {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_BODY',
            message: parsed.error.issues[0]?.message ?? 'Invalid payment link request.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const {
        customerPhone,
        customerName,
        items: itemsRaw,
        extraAmountFils,
        extraAmountNote,
        language,
      } = parsed.data;
      const items = itemsRaw ?? [];
      const extraFils = extraAmountFils ?? 0;
      const user = getAuthUser(req);

      // ── Load store ──────────────────────────────────────────────────────────
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          domain: true,
          slug: true,
          currency: true,
          wbsEnabled: true,
          credentials: { select: { wbsApiKey: true } },
        },
      });
      if (!store) {
        res.status(404).json({
          success: false,
          error: { code: 'STORE_NOT_FOUND', message: 'Store not found.' },
        });
        return;
      }
      if (!store.wbsEnabled || !store.credentials?.wbsApiKey) {
        res.status(400).json({
          success: false,
          error: {
            code: 'WBS_NOT_CONFIGURED',
            message: 'Connect WBS first before sending payment links via WhatsApp.',
          },
        });
        return;
      }

      // ── Confirm the paymentLink template is approved ────────────────────────
      const tmpl = await prisma.whatsAppTemplate.findUnique({
        where: {
          storeId_sourceKey_language: {
            storeId,
            sourceKey: 'paymentLink',
            language: language || 'en',
          },
        },
        select: { metaName: true, status: true },
      });
      if (!tmpl) {
        res.status(400).json({
          success: false,
          error: {
            code: 'TEMPLATE_NOT_FOUND',
            message: 'paymentLink template is not seeded. Generate templates first.',
          },
        });
        return;
      }
      if (tmpl.status !== 'approved') {
        res.status(400).json({
          success: false,
          error: {
            code: 'TEMPLATE_NOT_APPROVED',
            message: `paymentLink template status is ${tmpl.status}. Wait for Meta approval before sending.`,
            details: { templateStatus: tmpl.status },
          },
        });
        return;
      }

      // ── Validate items + compute total ─────────────────────────────────────
      const productIds = items.map(i => i.productId);
      const products = productIds.length
        ? await prisma.product.findMany({
            // B2B-7b: payment links are anonymous-priced; a wholesale-only product is PRODUCT_NOT_FOUND here
            where: {
              id: { in: productIds },
              storeId,
              status: 'active',
              deletedAt: null,
              audience: 'public',
            },
            select: {
              id: true,
              name: true,
              price: true,
              moq: true,
              nameAr: true,
              sku: true,
              costPrice: true,
              // EFFECTIVE_STOCK_SELECT supplies inventory/trackInventory/
              // allowBackorder plus the variants the stock check needs.
              ...EFFECTIVE_STOCK_SELECT,
              // Widened: the chosen variant's id, price and names are the line's.
              variants: {
                select: {
                  id: true,
                  price: true,
                  sku: true,
                  title: true,
                  titleAr: true,
                  costPrice: true,
                  inventory: true,
                  allowBackorder: true,
                  isActive: true,
                },
              },
            },
          })
        : [];
      const byId = new Map(products.map(p => [p.id, p]));
      // Backorder is a DUAL gate everywhere else in the codebase — the
      // store-level feature flag AND the per-product flag. This route
      // previously honoured only the per-product flag; resolving the feature
      // here brings it in line with checkout and the WhatsApp bridge.
      const backorderFeatureEnabled = await featureService.isFeatureEnabled(
        storeId,
        'inventory.backorder'
      );
      for (const it of items) {
        const p = byId.get(it.productId);
        if (!p) {
          res.status(400).json({
            success: false,
            error: {
              code: 'PRODUCT_NOT_FOUND',
              message: `Product ${it.productId} not in this store.`,
              details: { productId: it.productId },
            },
          });
          return;
        }
        // C-01 on the merchant path: a product with variants is sold as ONE of
        // them. A bare parent here wrote a SIZELESS order line (W1a review).
        if (!it.variantId && p.variants.length > 0) {
          const err = variantRequiredError(p.id, p.name);
          res.status(400).json({
            success: false,
            error: { code: err.code, message: err.message, details: err.details },
          });
          return;
        }
        const variant = it.variantId
          ? p.variants.find(v => v.id === it.variantId && v.isActive)
          : undefined;
        if (it.variantId && !variant) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VARIANT_NOT_FOUND',
              message: `Variant ${it.variantId} is not an active option of ${p.name}.`,
              details: { productId: it.productId, variantId: it.variantId },
            },
          });
          return;
        }
        // Variant-aware: with a variant chosen the line's stock is THAT
        // variant's; otherwise (a plain product) the product's own column.
        // Reading `p.inventory` for a variant product rejected every one whose
        // parent column had drifted negative (see lib/effective-inventory.ts).
        const orderable = variant
          ? isOrderable(
              {
                inventory: variant.inventory,
                trackInventory: p.trackInventory,
                allowBackorder: variant.allowBackorder || p.allowBackorder,
              },
              it.quantity,
              backorderFeatureEnabled
            )
          : isOrderable(p, it.quantity, backorderFeatureEnabled);
        if (!orderable) {
          res.status(400).json({
            success: false,
            error: {
              code: 'OUT_OF_STOCK',
              message: `${p.name} has insufficient stock.`,
              details: { productId: it.productId, productName: p.name },
            },
          });
          return;
        }
      }
      // A chosen variant's own price wins over the parent's (same rule as the cart).
      const lineVariant = (it: (typeof items)[number]) =>
        it.variantId
          ? byId.get(it.productId)?.variants.find(v => v.id === it.variantId)
          : undefined;
      // Price through the ONE resolver. Design review I6 / Ruling B2B-2d: a payment link is priced as an ANONYMOUS buyer
      // (retail + PUBLIC tiers) - the customer here is found by a typed WhatsApp phone, which is not a price identity, so
      // the group price is never resolved. MOQ is enforced (422 BELOW_MOQ); the entitlement is read UNCACHED (review I2).
      const linkResolver = await PriceResolver.forBuyer(storeId, ANONYMOUS_BUYER, {
        uncachedEntitlement: wholesaleEntitledUncached,
      });
      const linkPrices = await linkResolver.priceCart(
        items.map((it, i) => ({
          key: String(i),
          product: {
            id: it.productId,
            price: byId.get(it.productId)?.price ?? 0,
            moq: byId.get(it.productId)?.moq ?? null,
          },
          variant: lineVariant(it)
            ? { id: lineVariant(it)!.id, price: lineVariant(it)!.price }
            : null,
          qty: it.quantity,
        }))
      );
      const linkProductQty = new Map<string, number>();
      for (const it of items) {
        linkProductQty.set(it.productId, (linkProductQty.get(it.productId) ?? 0) + it.quantity);
      }
      try {
        assertMoqSatisfied(
          items.map((it, i) => ({
            productId: it.productId,
            name: byId.get(it.productId)?.name ?? it.productId,
            nameAr: byId.get(it.productId)?.nameAr ?? null,
            current: linkProductQty.get(it.productId) ?? it.quantity,
            resolved: linkPrices.get(String(i))!,
          }))
        );
      } catch (err) {
        if (err instanceof AppError) {
          res.status(err.statusCode).json({
            success: false,
            error: { code: err.code, message: err.message, details: err.details },
          });
          return;
        }
        throw err;
      }
      const linePricing = (it: (typeof items)[number]) =>
        linkPrices.get(String(items.indexOf(it)))!;
      const unitPrice = (it: (typeof items)[number]) => linePricing(it).unitMinor;
      const itemsSubtotal = items.reduce((sum, it) => sum + unitPrice(it) * it.quantity, 0);
      // VAT (rulings TAX-2, MONEYB-2): a payment-link order is a sale like any
      // other — a VAT-verified store charges VAT on the items AND on the extra
      // amount (a service fee / deposit is part of the supply). It used to be
      // created with tax 0 whatever the store's registration.
      const activeTax = await resolveActiveTaxRate(storeId);
      const amounts = computeOrderAmounts({
        subtotal: itemsSubtotal,
        discount: 0,
        shipping: 0,
        codFee: extraFils,
        ratePercent: activeTax.ratePercent,
        includedInPrice: activeTax.includedInPrice,
      });
      const totalFils = amounts.total;

      // Plan order cap (locked pricing): a WhatsApp payment link creates an order too, so
      // it passes the same gate as checkout BEFORE any customer/order row is written.
      await assertOrderAllowed(storeId);

      // ── Find or create Customer ────────────────────────────────────────────
      // The User model is the customer record (role='customer', scoped to storeId).
      // email is required+non-nullable on the User model — use a placeholder
      // derived from the phone number for WA-initiated customers.
      const placeholderEmail = `wa-${customerPhone.replace(/\D/g, '')}@placeholder.forcestore.kw`;
      const firstName = customerName?.split(' ')[0] || null;
      const lastName = customerName?.split(' ').slice(1).join(' ') || null;

      let customer = await prisma.user.findFirst({
        where: { phone: customerPhone, role: 'customer', storeId },
      });
      if (!customer) {
        // Try by placeholder email within the store first (idempotent re-runs)
        customer = await prisma.user.findFirst({
          where: { email: placeholderEmail, storeId, role: 'customer' },
        });
      }
      if (!customer) {
        customer = await prisma.user.create({
          data: {
            storeId,
            email: placeholderEmail,
            passwordHash: '',
            firstName: firstName || 'Customer',
            lastName: lastName || '',
            phone: customerPhone,
            role: 'customer',
          },
        });
      }

      // ── Create draft Order ─────────────────────────────────────────────────
      const orderNumber = generateOrderNumber('WA');
      const draftOrder = await prisma.order.create({
        data: {
          storeId,
          customerId: customer.id,
          orderNumber,
          status: 'pending',
          paymentStatus: 'unpaid',
          subtotal: itemsSubtotal,
          tax: amounts.tax,
          taxIncludedInPrice: activeTax.includedInPrice,
          ...frozenTaxInvoiceFields(activeTax),
          taxableAmount: amounts.taxableAmount,
          shipping: 0,
          discount: 0,
          total: totalFils,
          extraAmount: extraFils,
          extraAmountNote: extraAmountNote || null,
          currency: store.currency || REGION.currency,
          shippingAddress: {
            phone: normalizePhoneForStorage(customerPhone),
            firstName: customer.firstName,
            lastName: customer.lastName,
            _source: 'wa_payment_link',
          },
          billingAddress: {
            phone: normalizePhoneForStorage(customerPhone),
            firstName: customer.firstName,
            lastName: customer.lastName,
            _source: 'wa_payment_link',
          },
          notes: 'Created via merchant-initiated WhatsApp payment link',
          locale: language || 'en',
          items: {
            create: items.map(it => {
              const p = byId.get(it.productId)!;
              const v = lineVariant(it);
              const price = unitPrice(it);
              return {
                productId: it.productId,
                productName: p.name,
                variantId: v?.id ?? null,
                variantName: v?.title ?? null,
                variantNameAr: v?.titleAr || null,
                quantity: it.quantity,
                price,
                ...priceSnapshot(linePricing(it)),
                total: price * it.quantity,
                sku: v?.sku || p.sku || null,
                // `??`, not `||`: a genuine 0 cost is a known cost.
                costPrice: v?.costPrice ?? p.costPrice ?? null,
              };
            }),
          },
        },
        include: { items: true, customer: true },
      });
      draftOrderId = draftOrder.id;

      // ── Mint the payment link ───────────────────────────────────────
      const storefrontBaseUrl = storefrontOrigin(store);

      const customerDisplayName =
        `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim() || 'Customer';

      // Resolve the store's configured payment provider FIRST so we can
      // build the provider-specific webhook URL. Each provider posts
      // back to /api/v1/webhooks/payment/<provider-name>; hardcoding
      // a fixed name would break merchants on another gateway because
      // the matching handler verifies provider-specific signatures.
      const providerName = await PaymentService.getDefaultProvider(storeId);
      if (!providerName) {
        // Don't leave the draft Order orphaned — clean it up.
        await prisma.order.delete({ where: { id: draftOrder.id, storeId } }).catch(() => null);
        res.status(400).json({
          success: false,
          error: {
            code: 'PAYMENT_NOT_CONFIGURED',
            message:
              'Configure a payment provider in Store Settings → Payments before sending payment links.',
          },
        });
        return;
      }

      const result = await PaymentService.createPayment(
        {
          orderId: draftOrder.id,
          orderNumber: draftOrder.orderNumber,
          amount: draftOrder.total,
          currency: draftOrder.currency as Currency,
          customer: {
            id: customer.id,
            name: customerDisplayName,
            email: customer.email || '',
            phone: customerPhone,
          },
          items: draftOrder.items.map(it => ({
            name: it.productName,
            quantity: it.quantity,
            unitPrice: it.price,
            sku: it.sku || undefined,
          })),
          callbackUrl: `${storefrontBaseUrl}/checkout/success`,
          errorUrl: `${storefrontBaseUrl}/checkout/error`,
          webhookUrl: paymentWebhookUrl(providerName, storeId),
          notifyVia: 'link',
        },
        providerName,
        storeId
      );

      const paymentUrl = result.paymentUrl;

      // ── Send via WBS paymentLink template ──────────────────────────────────
      let wbsApiKey: string;
      try {
        wbsApiKey = encryption.decrypt(store.credentials.wbsApiKey);
      } catch {
        // Clean up the draft order before failing
        await prisma.order.delete({ where: { id: draftOrderId, storeId } }).catch(() => {});
        draftOrderId = null;
        res.status(400).json({
          success: false,
          error: {
            code: 'WBS_KEY_INVALID',
            message: 'The stored WBS API key could not be read. Reconnect WBS.',
          },
        });
        return;
      }

      const currencyDisplay = language === 'ar' ? 'ج.م' : store.currency || REGION.currency;
      const totalDisplay = minorToDecimalString(totalFils);
      const storeName = language === 'ar' ? store.nameAr || store.name : store.name;
      const customerDisplay = customerName || (language === 'ar' ? 'العميل' : 'Customer');

      // paymentLink template variables (positional):
      //   {{1}} customer name
      //   {{2}} order total
      //   {{3}} currency
      //   {{4}} store name
      //   {{5}} payment URL (the gateway's hosted checkout)
      const variables = [customerDisplay, totalDisplay, currencyDisplay, storeName, paymentUrl];

      const idempotencyKey = `pl-${storeId}-${draftOrder.id}-${Date.now()}`;

      const wbsResponse = await fetch(`${config.wbsBaseUrl}/api/v1/external/send-template`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wbs-api-key': wbsApiKey,
        },
        body: JSON.stringify({
          recipientPhone: customerPhone,
          templateName: tmpl.metaName,
          languageCode: language || 'en',
          variables,
          idempotencyKey,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      const wbsBody = (await wbsResponse.json().catch(() => ({}))) as {
        success?: boolean;
        messageId?: string;
        error?: string;
        message?: string;
      };

      if (!wbsResponse.ok || !wbsBody.success) {
        logger.error(
          { status: wbsResponse.status, body: wbsBody, storeId },
          '[payment-links] WBS send failed'
        );
        // Clean up the orphan draft order
        await prisma.order.delete({ where: { id: draftOrderId, storeId } }).catch(() => {});
        draftOrderId = null;
        res.status(502).json({
          success: false,
          error: {
            code: 'WBS_SEND_FAILED',
            message: wbsBody.message || 'WhatsApp could not send the payment link.',
            // The bridge's own code, kept for diagnosis rather than as the
            // envelope's code, so the client sees one stable failure code.
            ...(wbsBody.error ? { details: { wbsError: wbsBody.error } } : {}),
          },
        });
        return;
      }

      // The sale's fiscal document, once the link really went out (a failed
      // mint/send above deletes the draft order, and an issued document can
      // never be deleted). Same request transaction as the order (MONEYB-1).
      // Inside the request's tenant transaction when there is one (the order
      // was written on it; a second transaction could not see it).
      if (hasTenantContext()) {
        await FiscalDocumentService.issueSaleDocument(
          prisma as unknown as Prisma.TransactionClient,
          storeId,
          draftOrder.id
        );
      } else {
        await withMoneyTx(prisma, tx =>
          FiscalDocumentService.issueSaleDocument(tx, storeId, draftOrder.id)
        );
      }

      // ── Audit log ──────────────────────────────────────────────────────────
      await auditLog({
        action: 'payment_link.merchant_initiated',
        userId: user.userId,
        resourceType: 'order',
        resourceId: draftOrder.id,
        details: {
          orderId: draftOrder.id,
          orderNumber: draftOrder.orderNumber,
          totalFils,
          invoiceId: result.invoiceId ?? null,
          messageId: wbsBody.messageId ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        {
          storeId,
          customerPhone: '[REDACTED]',
          totalFils,
          orderId: draftOrder.id,
          orderNumber: draftOrder.orderNumber,
          invoiceId: result.invoiceId,
          messageId: wbsBody.messageId,
        },
        '[payment-links] sent'
      );

      const PAYMENT_LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes

      res.json({
        success: true,
        data: {
          paymentUrl,
          orderId: draftOrder.id,
          orderNumber: draftOrder.orderNumber,
          invoiceId: result.invoiceId ?? null,
          totalFils,
          currency: store.currency || REGION.currency,
          messageId: wbsBody.messageId,
          expiresAt: new Date(Date.now() + PAYMENT_LINK_TTL_MS).toISOString(),
        },
      });
    } catch (err) {
      // If we created a draft order but something failed after, delete it
      // to avoid orphaned unpaid orders cluttering the merchant's order list.
      if (draftOrderId) {
        await prisma.order.delete({ where: { id: draftOrderId, storeId } }).catch(() => {});
      }
      logger.error({ err: (err as Error).message }, '[payment-links] create failed');
      next(err);
    }
  }
);

export default router;
