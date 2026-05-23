/**
 * Merchant-Initiated Payment Links — Phase 7 (rewritten Phase 7.1).
 *
 * Lets a store admin send a customer a WhatsApp message containing a
 * one-tap MyFatoorah hosted-checkout URL. Used for invoices, custom quotes,
 * or any out-of-band order.
 *
 * Flow:
 *   1. Validate input (phone, amount or items)
 *   2. Find-or-create a Customer row
 *   3. Create a draft Order (status=pending, paymentStatus=unpaid)
 *   4. Mint a MyFatoorah payment link via PaymentService.createPayment
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

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { config } from '../config';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { encryption } from '../services/encryption.service';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { getAuthUser } from '../utils/store-helpers';
import logger from '../lib/logger';
import type { Currency } from '../services/payment-providers/types';

const router = Router({ mergeParams: true });

const bodySchema = z
  .object({
    // Customer's phone in E.164 format
    customerPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164 (e.g. +96512345678)'),
    customerName: z.string().min(1).max(100).optional(),
    // Items from the catalogue (productId references). Optional when an
    // extraAmount is provided — a payment link can be ALL custom charge
    // (e.g. service deposit, custom quote) with no catalogued items.
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().min(1).max(99),
        })
      )
      .max(50)
      .optional(),
    // Out-of-catalogue charge in fils. Baked into Order.total + persisted
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
  writeLimiter,
  async (req: Request, res: Response) => {
    const storeId = req.params.id;
    let draftOrderId: string | null = null;

    try {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'INVALID_BODY',
          details: parsed.error.flatten(),
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
          wbsApiKey: true,
        },
      });
      if (!store) {
        res.status(404).json({ success: false, error: 'STORE_NOT_FOUND' });
        return;
      }
      if (!store.wbsEnabled || !store.wbsApiKey) {
        res.status(400).json({
          success: false,
          error: 'WBS_NOT_CONFIGURED',
          message: 'Connect WBS first before sending payment links via WhatsApp.',
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
          error: 'TEMPLATE_NOT_FOUND',
          message: 'paymentLink template is not seeded. Generate templates first.',
        });
        return;
      }
      if (tmpl.status !== 'approved') {
        res.status(400).json({
          success: false,
          error: 'TEMPLATE_NOT_APPROVED',
          message: `paymentLink template status is ${tmpl.status}. Wait for Meta approval before sending.`,
        });
        return;
      }

      // ── Validate items + compute total ─────────────────────────────────────
      const productIds = items.map(i => i.productId);
      const products = productIds.length
        ? await prisma.product.findMany({
            where: { id: { in: productIds }, storeId, status: 'active', deletedAt: null },
            select: {
              id: true,
              name: true,
              price: true,
              inventory: true,
              trackInventory: true,
              allowBackorder: true,
              sku: true,
              costPrice: true,
            },
          })
        : [];
      const byId = new Map(products.map(p => [p.id, p]));
      for (const it of items) {
        const p = byId.get(it.productId);
        if (!p) {
          res.status(400).json({
            success: false,
            error: 'PRODUCT_NOT_FOUND',
            message: `Product ${it.productId} not in this store.`,
          });
          return;
        }
        if (p.trackInventory && !p.allowBackorder && p.inventory < it.quantity) {
          res.status(400).json({
            success: false,
            error: 'OUT_OF_STOCK',
            message: `Product ${it.productId} has insufficient stock.`,
          });
          return;
        }
      }
      const itemsSubtotal = items.reduce((sum, it) => {
        const p = byId.get(it.productId);
        return sum + (p ? p.price * it.quantity : 0);
      }, 0);
      const totalFils = itemsSubtotal + extraFils;

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
      const orderNumber = `WA-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const draftOrder = await prisma.order.create({
        data: {
          storeId,
          customerId: customer.id,
          orderNumber,
          status: 'pending',
          paymentStatus: 'unpaid',
          subtotal: itemsSubtotal,
          tax: 0,
          shipping: 0,
          discount: 0,
          total: totalFils,
          extraAmount: extraFils,
          extraAmountNote: extraAmountNote || null,
          currency: store.currency || 'KWD',
          shippingAddress: {
            phone: customerPhone,
            firstName: customer.firstName,
            lastName: customer.lastName,
            _source: 'wa_payment_link',
          },
          billingAddress: {
            phone: customerPhone,
            firstName: customer.firstName,
            lastName: customer.lastName,
            _source: 'wa_payment_link',
          },
          notes: 'Created via merchant-initiated WhatsApp payment link',
          locale: language || 'en',
          items: {
            create: items.map(it => {
              const p = byId.get(it.productId)!;
              return {
                productId: it.productId,
                productName: p.name,
                quantity: it.quantity,
                price: p.price,
                total: p.price * it.quantity,
                sku: p.sku || null,
                costPrice: p.costPrice || null,
              };
            }),
          },
        },
        include: { items: true, customer: true },
      });
      draftOrderId = draftOrder.id;

      // ── Mint MyFatoorah payment link ───────────────────────────────────────
      const storefrontBaseUrl = store.domain
        ? `https://${store.domain}`
        : `${config.webUrl}/${store.slug}`;

      const customerDisplayName =
        `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim() || 'Customer';

      // Resolve the store's configured payment provider FIRST so we can
      // build the provider-specific webhook URL. Each provider posts
      // back to /api/v1/webhooks/payment/<provider-name>; hardcoding
      // /myfatoorah would break Tap / Hesabe / UPayments merchants
      // because the matching handler verifies provider-specific
      // signatures.
      const providerName = await PaymentService.getDefaultProvider(storeId);
      if (!providerName) {
        // Don't leave the draft Order orphaned — clean it up.
        await prisma.order.delete({ where: { id: draftOrder.id } }).catch(() => null);
        res.status(400).json({
          success: false,
          error: 'PAYMENT_NOT_CONFIGURED',
          message:
            'Configure a payment provider in Store Settings → Payments before sending payment links.',
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
          webhookUrl: `${config.apiUrl}/api/v1/webhooks/payment/${providerName}`,
          notifyVia: 'link',
        },
        providerName,
        storeId
      );

      const paymentUrl = result.paymentUrl;

      // ── Send via WBS paymentLink template ──────────────────────────────────
      let wbsApiKey: string;
      try {
        wbsApiKey = encryption.decrypt(store.wbsApiKey);
      } catch {
        // Clean up the draft order before failing
        await prisma.order.delete({ where: { id: draftOrderId } }).catch(() => {});
        draftOrderId = null;
        res.status(400).json({ success: false, error: 'WBS_KEY_INVALID' });
        return;
      }

      const currencyDisplay = language === 'ar' ? 'د.ك' : store.currency || 'KWD';
      const totalDisplay = (totalFils / 1000).toFixed(3);
      const storeName = language === 'ar' ? store.nameAr || store.name : store.name;
      const customerDisplay = customerName || (language === 'ar' ? 'العميل' : 'Customer');

      // paymentLink template variables (positional):
      //   {{1}} customer name
      //   {{2}} order total
      //   {{3}} currency
      //   {{4}} store name
      //   {{5}} payment URL (MyFatoorah hosted checkout)
      const variables = [customerDisplay, totalDisplay, currencyDisplay, storeName, paymentUrl];

      const wbsBaseUrl = config.wbsBaseUrl;
      const idempotencyKey = `pl-${storeId}-${draftOrder.id}-${Date.now()}`;

      const wbsResponse = await fetch(`${wbsBaseUrl}/api/v1/external/send-template`, {
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
        await prisma.order.delete({ where: { id: draftOrderId } }).catch(() => {});
        draftOrderId = null;
        res.status(502).json({
          success: false,
          error: wbsBody.error || 'WBS_SEND_FAILED',
          message: wbsBody.message,
        });
        return;
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
          currency: store.currency || 'KWD',
          messageId: wbsBody.messageId,
          expiresAt: new Date(Date.now() + PAYMENT_LINK_TTL_MS).toISOString(),
        },
      });
    } catch (err) {
      // If we created a draft order but something failed after, delete it
      // to avoid orphaned unpaid orders cluttering the merchant's order list.
      if (draftOrderId) {
        await prisma.order.delete({ where: { id: draftOrderId } }).catch(() => {});
      }
      logger.error({ err: (err as Error).message }, '[payment-links] create failed');
      res
        .status(500)
        .json({ success: false, error: 'CREATE_FAILED', message: (err as Error).message });
    }
  }
);

export default router;
