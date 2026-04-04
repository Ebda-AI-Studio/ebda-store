import { Router } from 'express';
import authRoutes from './auth.routes';
import storeRoutes from './store.routes';
import productRoutes from './product.routes';
import cartRoutes from './cart.routes';
import orderRoutes from './order.routes';
import reviewRoutes from './review.routes';
import analyticsRoutes from './analytics.routes';
import returnRoutes from './return.routes';
import publicRoutes from './public.routes';
import paymentRoutes from './payment.routes';
import paymentSettingsRoutes from './payment-settings.routes';
import uploadRoutes from './upload.routes';
import adminRoutes from './admin.routes';
import couponRoutes from './coupon.routes';
import shippingRoutes from './shipping.routes';
import taxRoutes from './tax.routes';
import loyaltyRoutes from './loyalty.routes';
import pwaRoutes from './pwa.routes';
import inventoryRoutes from './inventory.routes';
import bulkRoutes from './bulk.routes';
import variantRoutes from './variant.routes';
import categoryRoutes from './category.routes';
import wishlistRoutes from './wishlist.routes';
import addressRoutes from './address.routes';
import featureRoutes from './feature.routes';
import notificationRoutes from './notification.routes';
import abandonedCartRoutes from './abandoned-cart.routes';
import recommendationRoutes from './recommendation.routes';
import shippingCarrierRoutes from './shipping-carrier.routes';
import affiliateRoutes from './affiliate.routes';
import { tenantContext } from '../middleware/tenant-context';

const router = Router();

// Public routes (no auth required)
router.use('/public', publicRoutes);
router.use('/auth', authRoutes);

// Payment routes
router.use('/payments', paymentRoutes);

// Payment settings (super admin)
router.use('/payment-settings', paymentSettingsRoutes);

// Upload routes
router.use('/uploads', uploadRoutes);

// Admin routes (super_admin only — tenantContext activates per-route via :id param)
router.use('/admin', tenantContext, adminRoutes);

// Feature management routes (super_admin: /admin/stores/:id/features, store_admin: /stores/:storeId/my-features)
router.use('/admin', tenantContext, featureRoutes);
router.use('/stores', tenantContext, featureRoutes);

// Store routes (tenantContext activates when :storeId or :id is present)
router.use('/stores', tenantContext, storeRoutes);

// Store-scoped routes — tenantContext wraps all downstream handlers in an RLS transaction
router.use('/stores/:storeId/products', tenantContext, productRoutes);
router.use('/stores/:storeId/categories', tenantContext, categoryRoutes);
router.use('/stores/:storeId/cart', tenantContext, cartRoutes);
router.use('/stores/:storeId/orders', tenantContext, orderRoutes);
router.use('/stores/:storeId/reviews', tenantContext, reviewRoutes);
router.use('/stores/:storeId/analytics', tenantContext, analyticsRoutes);
router.use('/stores/:storeId/returns', tenantContext, returnRoutes);

// Store-scoped routes mounted under /stores (storeId in sub-route params)
router.use('/stores', tenantContext, couponRoutes);
router.use('/stores', tenantContext, shippingRoutes);
router.use('/stores', tenantContext, taxRoutes);
router.use('/stores', tenantContext, loyaltyRoutes);
router.use('/stores', tenantContext, pwaRoutes);
router.use('/stores', tenantContext, inventoryRoutes);
router.use('/stores', tenantContext, bulkRoutes);
router.use('/stores', tenantContext, variantRoutes);

// Notification routes (admin + public push)
router.use('/stores', tenantContext, notificationRoutes);
router.use('/public', notificationRoutes);

// Abandoned cart routes (admin + public recovery)
router.use('/stores', tenantContext, abandonedCartRoutes);
router.use('/public', abandonedCartRoutes);

// Recommendation routes (admin + public)
router.use('/stores', tenantContext, recommendationRoutes);
router.use('/public', recommendationRoutes);

// Shipping carrier routes (admin + public tracking)
router.use('/stores', tenantContext, shippingCarrierRoutes);
router.use('/public', shippingCarrierRoutes);

// Affiliate routes (admin + public apply/track)
router.use('/stores', tenantContext, affiliateRoutes);
router.use('/public', affiliateRoutes);

// Wishlist routes (user-scoped, no store context)
router.use('/wishlist', wishlistRoutes);

// Address routes (user-scoped, no store context)
router.use('/addresses', addressRoutes);

export default router;
