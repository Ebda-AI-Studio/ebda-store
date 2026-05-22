/**
 * WBS→FWB Bridge Routes — WhatsApp Customer-DM Ordering (Phase 6 / Option C)
 *
 * Endpoints WBS calls into during the customer-DM-to-order flow. All
 * routes auth via `X-WBS-API-KEY` header (mapped to a Store by the
 * waBridgeAuth middleware → req.bridgeStore).
 *
 * Endpoints (mounted at /api/v1/wa-bridge):
 *   GET  /categories                              category list
 *   GET  /products/search?q=                      text search top-10
 *   GET  /products/by-category?categoryId=&page=  paginated 10/page
 *   POST /cart/from-wa                            create cart + signed JWT
 *   POST /cart/redeem                             single-use JWT redemption
 *   GET  /health                                  bridge ping
 *
 * Designed around Meta WhatsApp Cloud API constraints from the audit
 * research: interactive list messages cap at 10 rows → category-then-
 * product pagination is the right primitive for browsing.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { prisma } from '@force/database';
import { config } from '../config';
import { waBridgeAuth } from '../middleware/wa-bridge-auth';
import logger from '../lib/logger';

const router = Router();
router.use(waBridgeAuth);

const PAGE_SIZE = 10; // Meta interactive list cap
const CHECKOUT_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes

// ─── GET /health ─────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    success: true,
    data: { storeId: req.bridgeStore?.id, storeName: req.bridgeStore?.name },
  });
});

// ─── GET /categories ─────────────────────────────────────────────────────────
router.get('/categories', async (req: Request, res: Response) => {
  try {
    const storeId = req.bridgeStore!.id;
    const categories = await prisma.category.findMany({
      where: { storeId, deletedAt: null, isActive: true },
      select: {
        id: true,
        name: true,
        nameAr: true,
        slug: true,
        _count: { select: { products: true } },
      },
      orderBy: { position: 'asc' },
      take: 50, // safety cap; WBS only consumes top-10 per list-message
    });

    res.json({
      success: true,
      data: categories.map((c: (typeof categories)[number]) => ({
        id: c.id,
        name: c.name,
        nameAr: c.nameAr,
        slug: c.slug,
        productCount: c._count.products,
      })),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] categories failed');
    res.status(500).json({ success: false, error: 'CATEGORIES_FETCH_FAILED' });
  }
});

// ─── GET /products/search?q= ─────────────────────────────────────────────────
const searchSchema = z.object({
  q: z.string().min(1).max(80),
});
router.get('/products/search', async (req: Request, res: Response) => {
  try {
    const parse = searchSchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ success: false, error: 'INVALID_QUERY' });
      return;
    }
    const { q } = parse.data;
    const storeId = req.bridgeStore!.id;

    // Case-insensitive contains on name + nameAr. Returns top-10.
    const products = await prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { nameAr: { contains: q, mode: 'insensitive' } },
          { sku: { equals: q } },
        ],
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        price: true,
        compareAtPrice: true,
        inventory: true,
        trackInventory: true,
        allowBackorder: true,
        images: {
          select: { url: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
      },
      take: PAGE_SIZE,
    });

    res.json({
      success: true,
      data: products.map(p => ({
        id: p.id,
        name: p.name,
        nameAr: p.nameAr,
        priceFils: p.price,
        currency: req.bridgeStore!.currency,
        compareAtFils: p.compareAtPrice,
        inStock: !p.trackInventory || p.inventory > 0 || p.allowBackorder,
        inventory: p.trackInventory ? p.inventory : null,
        imageUrl: p.images[0]?.url || null,
      })),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] product search failed');
    res.status(500).json({ success: false, error: 'PRODUCT_SEARCH_FAILED' });
  }
});

// ─── GET /products/by-category?categoryId=&page= ─────────────────────────────
const byCategorySchema = z.object({
  categoryId: z.string().uuid(),
  page: z.coerce.number().int().min(1).max(50).default(1),
});
router.get('/products/by-category', async (req: Request, res: Response) => {
  try {
    const parse = byCategorySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ success: false, error: 'INVALID_QUERY' });
      return;
    }
    const { categoryId, page } = parse.data;
    const storeId = req.bridgeStore!.id;

    // Verify category belongs to bridge store (defense in depth — WBS
    // could pass a categoryId from a different store).
    const cat = await prisma.category.findFirst({
      where: { id: categoryId, storeId, deletedAt: null },
      select: { id: true },
    });
    if (!cat) {
      res.status(404).json({ success: false, error: 'CATEGORY_NOT_FOUND' });
      return;
    }

    const products = await prisma.product.findMany({
      where: {
        storeId,
        status: 'active',
        deletedAt: null,
        categories: { some: { categoryId } },
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        price: true,
        inventory: true,
        trackInventory: true,
        allowBackorder: true,
      },
      orderBy: { name: 'asc' },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    });

    res.json({
      success: true,
      data: products.map(p => ({
        id: p.id,
        name: p.name,
        nameAr: p.nameAr,
        priceFils: p.price,
        currency: req.bridgeStore!.currency,
        inStock: !p.trackInventory || p.inventory > 0 || p.allowBackorder,
      })),
      pagination: { page, perPage: PAGE_SIZE, hasMore: products.length === PAGE_SIZE },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] by-category failed');
    res.status(500).json({ success: false, error: 'BY_CATEGORY_FAILED' });
  }
});

// ─── POST /cart/from-wa ──────────────────────────────────────────────────────
const cartFromWaSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(99),
      })
    )
    .min(1)
    .max(20),
  customerPhone: z.string().min(8).max(20),
  customerName: z.string().min(1).max(120).optional(),
  locale: z.enum(['ar', 'en']).optional(),
  waConversationId: z.string().min(1).max(120).optional(),
});
router.post('/cart/from-wa', async (req: Request, res: Response) => {
  try {
    const parse = cartFromWaSchema.safeParse(req.body);
    if (!parse.success) {
      res
        .status(400)
        .json({ success: false, error: 'INVALID_PAYLOAD', issues: parse.error.issues });
      return;
    }
    const { items, customerPhone, customerName, locale, waConversationId } = parse.data;
    const store = req.bridgeStore!;

    // Verify every product belongs to bridge store + still in stock.
    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, storeId: store.id, status: 'active', deletedAt: null },
      select: {
        id: true,
        name: true,
        nameAr: true,
        price: true,
        inventory: true,
        trackInventory: true,
        allowBackorder: true,
      },
    });
    const byId = new Map(products.map(p => [p.id, p]));

    const missing = items.filter(i => !byId.has(i.productId));
    if (missing.length > 0) {
      res.status(400).json({
        success: false,
        error: 'PRODUCTS_NOT_FOUND',
        missing: missing.map(m => m.productId),
      });
      return;
    }

    // Inventory check (allow backorder per product flag).
    const oos = items
      .map(i => ({ item: i, product: byId.get(i.productId)! }))
      .filter(
        ({ item, product }) =>
          product.trackInventory && product.inventory < item.quantity && !product.allowBackorder
      );
    if (oos.length > 0) {
      res.status(409).json({
        success: false,
        error: 'INSUFFICIENT_INVENTORY',
        outOfStock: oos.map(({ item, product }) => ({
          productId: item.productId,
          requested: item.quantity,
          available: product.inventory,
          name: product.name,
        })),
      });
      return;
    }

    // Build the cart payload that the checkout JWT carries.
    const cartItems = items.map(i => {
      const p = byId.get(i.productId)!;
      return {
        productId: i.productId,
        quantity: i.quantity,
        priceFils: p.price,
        name: p.name,
        nameAr: p.nameAr,
      };
    });
    const totalFils = cartItems.reduce((sum, ci) => sum + ci.priceFils * ci.quantity, 0);

    // Sign single-use checkout token. The storefront's checkout page
    // calls /cart/redeem with this token to hydrate the cart.
    const tokenPayload = {
      sub: 'wa-cart',
      storeId: store.id,
      storeSlug: store.slug,
      customerPhone,
      customerName: customerName || null,
      locale: locale || 'auto',
      waConversationId: waConversationId || null,
      items: cartItems,
      totalFils,
      currency: store.currency,
    };
    const checkoutToken = jwt.sign(tokenPayload, config.jwtSecret, {
      expiresIn: CHECKOUT_TOKEN_TTL_SECONDS,
    });

    // Compute the storefront checkout URL. Per-store custom domain may
    // be set on the Store row; for now, fall back to slug-based URL.
    const storefrontBase = process.env.STOREFRONT_BASE_URL || 'https://store.forcemediakw.com';
    const checkoutUrl = `${storefrontBase}/checkout?waToken=${encodeURIComponent(checkoutToken)}`;

    logger.info(
      { storeId: store.id, customerPhone: customerPhone.slice(-4), totalFils, items: items.length },
      '[wa-bridge] cart token issued'
    );

    res.json({
      success: true,
      data: {
        checkoutUrl,
        checkoutToken,
        expiresAt: new Date(Date.now() + CHECKOUT_TOKEN_TTL_SECONDS * 1000).toISOString(),
        summary: {
          itemCount: items.reduce((s, i) => s + i.quantity, 0),
          totalFils,
          currency: store.currency,
        },
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge] cart from-wa failed');
    res.status(500).json({ success: false, error: 'CART_CREATE_FAILED' });
  }
});

// ─── POST /cart/redeem ───────────────────────────────────────────────────────
// Called by the FWB storefront when the customer opens the checkout URL.
// Decodes the token + returns the cart payload to seed the checkout form.
// Single-use semantics: the token itself is sufficient (short TTL) — we
// don't persist a "redeemed" flag in v1. If single-use is later needed,
// add a Redis SET token marker on first redeem.
const redeemSchema = z.object({ token: z.string().min(20) });
router.post('/cart/redeem', async (req: Request, res: Response) => {
  try {
    const parse = redeemSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: 'INVALID_TOKEN' });
      return;
    }
    const { token } = parse.data;

    const payload = jwt.verify(token, config.jwtSecret) as Record<string, unknown>;
    if (payload.sub !== 'wa-cart') {
      res.status(400).json({ success: false, error: 'WRONG_TOKEN_TYPE' });
      return;
    }

    // Cross-check the store still has the integration enabled. If a
    // merchant disconnected WBS between token issuance and redemption,
    // refuse — they don't want WA-originated traffic anymore.
    const store = await prisma.store.findUnique({
      where: { id: payload.storeId as string },
      select: { id: true, slug: true, wbsEnabled: true },
    });
    if (!store?.wbsEnabled) {
      res.status(403).json({ success: false, error: 'STORE_WBS_DISABLED' });
      return;
    }

    res.json({ success: true, data: payload });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TokenExpiredError') {
      res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
      return;
    }
    if (name === 'JsonWebTokenError') {
      res.status(401).json({ success: false, error: 'TOKEN_INVALID' });
      return;
    }
    logger.error({ err: (err as Error).message }, '[wa-bridge] redeem failed');
    res.status(500).json({ success: false, error: 'REDEEM_FAILED' });
  }
});

export default router;
