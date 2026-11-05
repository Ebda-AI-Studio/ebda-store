import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { authenticate, authorize, customerUserId } from '../middleware/auth';
import { requireCustomerStoreMatch } from '../middleware/customer-store-match';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import {
  WalletService,
  WALLET_MAX_ENTRY_FILS,
  storeCustomerWhere,
} from '../services/wallet.service';

/**
 * Customer wallet (store credit) routes. Every route is behind
 * `requireFeature('customer_wallet')`, which is OFF for every store until a
 * super-admin override turns it on (docs/plans/2026-09-25-customer-wallet.md).
 *
 * Mounted at the bare '/stores' prefix, so every path declares its own
 * '/:storeId/…' and RLS context comes from `router.param` (same shape as
 * loyalty.routes.ts). The customer-facing paths therefore live at
 * `/stores/public/:storeId/wallet…` — NOT `/public/:storeId/…`, which is a
 * different router (public.routes.ts) and 404s.
 */
const router = Router();
router.param('storeId', tenantContext);

const cursorQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const adjustSchema = z.object({
  /** Signed piastres: positive credits, negative debits. */
  amount: z
    .number()
    .int()
    .refine(v => v !== 0, 'Amount must not be zero')
    .refine(v => Math.abs(v) <= WALLET_MAX_ENTRY_FILS, 'Amount is too large'),
  note: z.string().trim().min(1).max(500),
  /** Client-generated per-submit UUID — a double-click or retry replays. */
  idempotencyKey: z.string().uuid(),
});

/** 404 unless the id is a customer account of THIS store. */
async function assertStoreCustomer(storeId: string, customerId: string, res: Response) {
  const customer = await prisma.user.findFirst({
    where: { ...storeCustomerWhere(storeId, customerId), storeId },
    select: { id: true },
  });
  if (!customer) {
    res.status(404).json({
      success: false,
      error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' },
    });
    return false;
  }
  return true;
}

// ==========================================
// Admin
// ==========================================

// GET /stores/:storeId/wallets — customers holding a balance + store totals
router.get(
  '/:storeId/wallets',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('customer_wallet'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const q = cursorQuerySchema.parse(req.query);
      const [result, checkout] = await Promise.all([
        WalletService.listWallets(storeId, q),
        WalletService.getCheckoutAvailability(storeId),
      ]);
      res.json({ success: true, data: { ...result, checkout } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/customers/:customerId/wallet — balance + ledger page
router.get(
  '/:storeId/customers/:customerId/wallet',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('customer_wallet'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;
      const q = cursorQuerySchema.parse(req.query);
      if (!(await assertStoreCustomer(storeId, customerId, res))) return;
      const [balance, page] = await Promise.all([
        WalletService.getBalance(storeId, customerId),
        WalletService.listTransactions(storeId, customerId, q),
      ]);
      res.json({ success: true, data: { balance, ...page } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/customers/:customerId/wallet/adjustments — manual
// credit (+) / debit (−), note required, audited.
router.post(
  '/:storeId/customers/:customerId/wallet/adjustments',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('customer_wallet'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;
      const body = adjustSchema.parse(req.body);
      if (!(await assertStoreCustomer(storeId, customerId, res))) return;
      const actorId = getAuthUser(req).userId;

      const result = await WalletService.adminAdjust({
        storeId,
        customerId,
        amount: body.amount,
        note: body.note,
        actorId,
        requestKey: body.idempotencyKey,
      });

      if (!result.replayed) {
        await auditLog({
          action: 'customer.wallet.adjusted',
          userId: actorId,
          storeId,
          resourceType: 'customer_wallet',
          resourceId: customerId,
          details: {
            entryId: result.entry.id,
            amount: body.amount,
            note: body.note,
            balanceAfter: result.balance,
          },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }

      res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: { entry: result.entry, balance: result.balance, replayed: result.replayed },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Customer (storefront)
// ==========================================

function requireCustomer(req: Request, res: Response): string | null {
  // customerUserId() rejects admin/staff tokens: the API cookie is shared
  // between the admin and storefront origins, so a merchant browsing the
  // storefront must never read a "wallet" keyed on their own admin id.
  const customerId = customerUserId(req);
  if (!customerId) {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Customer account required' },
    });
    return null;
  }
  return customerId;
}

// GET /stores/public/:storeId/wallet — own balance + whether it can be spent
router.get(
  '/public/:storeId/wallet',
  authenticate,
  requireCustomerStoreMatch,
  requireFeature('customer_wallet'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = requireCustomer(req, res);
      if (!customerId) return;
      const { storeId } = req.params;
      const [balance, checkout] = await Promise.all([
        WalletService.getBalance(storeId, customerId),
        WalletService.getCheckoutAvailability(storeId),
      ]);
      res.json({
        success: true,
        data: { balance, checkoutAvailable: checkout.available },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/public/:storeId/wallet/transactions — own history
router.get(
  '/public/:storeId/wallet/transactions',
  authenticate,
  requireCustomerStoreMatch,
  requireFeature('customer_wallet'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customerId = requireCustomer(req, res);
      if (!customerId) return;
      const { storeId } = req.params;
      const q = cursorQuerySchema.parse(req.query);
      const page = await WalletService.listTransactions(storeId, customerId, q);
      // The shopper sees what happened, not who on the merchant's team did it
      // or the internal key/note the merchant typed.
      res.json({
        success: true,
        data: {
          transactions: page.transactions.map(t => ({
            id: t.id,
            amount: t.amount,
            balanceAfter: t.balanceAfter,
            type: t.type,
            createdAt: t.createdAt,
            order: t.order ? { orderNumber: t.order.orderNumber } : null,
            return: t.return ? { returnNumber: t.return.returnNumber } : null,
          })),
          nextCursor: page.nextCursor,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
