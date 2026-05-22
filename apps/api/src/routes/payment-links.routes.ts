/**
 * Merchant-Initiated Payment Links — Phase 7.
 *
 * Lets a store admin send a customer a WhatsApp message containing a
 * one-tap payment link. Used for invoices, custom quotes, or any
 * out-of-band order. Kuwait doesn't have WhatsApp Pay so we ship the
 * customer a Force Store checkout URL signed as a 30-minute JWT.
 *
 * Routes:
 *   POST /stores/:id/payment-links
 *     body: { customerPhone, items?: [{productId, quantity}],
 *             amountFils?, customerName?, language? }
 *     creates the link, calls WBS to send the paymentLink template,
 *     returns the URL + JWT for record-keeping.
 *
 * The customer taps the URL → /checkout?waToken=<jwt> → existing
 * WaTokenHydrator hydrates the cart → existing checkout flow → pays.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { prisma } from '@force/database';
import { config } from '../config';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { encryption } from '../services/encryption.service';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

const CHECKOUT_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes

const bodySchema = z
  .object({
    // Customer's phone in E.164 format
    customerPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164 (e.g. +96512345678)'),
    customerName: z.string().min(1).max(100).optional(),
    // Either: items (existing products) OR amountFils (open amount, no SKU)
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().min(1).max(99),
        })
      )
      .max(50)
      .optional(),
    amountFils: z.number().int().min(100).max(100_000_000).optional(),
    // Override paymentLink template language for this send (default = store default)
    language: z.enum(['en', 'ar']).optional(),
  })
  .refine(d => (d.items && d.items.length > 0) || typeof d.amountFils === 'number', {
    message: 'Either items[] or amountFils is required',
  });

router.post(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response) => {
    const storeId = req.params.id;
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
      const { customerPhone, customerName, items, amountFils, language } = parsed.data;

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

      // Confirm the chosen paymentLink template is approved before we send.
      // If it's pending or rejected, fail loudly — sending a non-approved
      // template will be rejected by Meta + waste the customer's first
      // touch with our brand.
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

      // Validate items belong to this store + are in stock; compute total
      // for the WhatsApp message text. Open amount (amountFils) bypasses
      // this — admin-trusted to enter the right number.
      let totalFils = amountFils || 0;
      if (items && items.length > 0) {
        const productIds = items.map(i => i.productId);
        const products = await prisma.product.findMany({
          where: { id: { in: productIds }, storeId, status: 'active', deletedAt: null },
          select: {
            id: true,
            price: true,
            inventory: true,
            trackInventory: true,
            allowBackorder: true,
          },
        });
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
        totalFils = items.reduce((sum, it) => {
          const p = byId.get(it.productId);
          return sum + (p ? p.price * it.quantity : 0);
        }, 0);
      }

      // Sign the JWT — same shape as Phase 6 /cart/from-wa
      const tokenPayload: Record<string, unknown> = {
        sub: 'payment-link',
        storeId,
        phone: customerPhone,
        items: items || null,
        amountFils: items ? null : totalFils,
        createdBy: req.user?.userId || null,
      };
      const checkoutToken = jwt.sign(tokenPayload, config.jwtSecret, {
        expiresIn: CHECKOUT_TOKEN_TTL_SECONDS,
      });

      // Build the storefront checkout URL. Use the store's domain if set,
      // otherwise fall back to the slug-based subdomain (the storefront
      // resolves either).
      const baseUrl = store.domain
        ? `https://${store.domain}`
        : `https://${store.slug}.forcestore.kw`;
      const checkoutUrl = `${baseUrl}/checkout?waToken=${encodeURIComponent(checkoutToken)}`;

      // Call WBS to send the paymentLink template.
      let wbsApiKey: string;
      try {
        wbsApiKey = encryption.decrypt(store.wbsApiKey);
      } catch {
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
      //   {{5}} checkout URL
      const variables = [customerDisplay, totalDisplay, currencyDisplay, storeName, checkoutUrl];

      const wbsBaseUrl = config.wbsBaseUrl;
      const idempotencyKey = `pl-${storeId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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
        res.status(502).json({
          success: false,
          error: wbsBody.error || 'WBS_SEND_FAILED',
          message: wbsBody.message,
        });
        return;
      }

      logger.info(
        { storeId, customerPhone: '[REDACTED]', totalFils, messageId: wbsBody.messageId },
        '[payment-links] sent'
      );

      res.json({
        success: true,
        data: {
          checkoutUrl,
          checkoutToken,
          totalFils,
          currency: store.currency || 'KWD',
          messageId: wbsBody.messageId,
          expiresAt: new Date(Date.now() + CHECKOUT_TOKEN_TTL_SECONDS * 1000).toISOString(),
        },
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[payment-links] create failed');
      res.status(500).json({ success: false, error: 'CREATE_FAILED' });
    }
  }
);

export default router;
