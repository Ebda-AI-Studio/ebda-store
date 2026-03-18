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

// Admin routes (super_admin only)
router.use('/admin', adminRoutes);

// Feature management routes (super_admin: /admin/stores/:id/features, store_admin: /stores/:storeId/my-features)
router.use('/admin', featureRoutes);
router.use('/stores', featureRoutes);

// Store routes
router.use('/stores', storeRoutes);

// Product routes (scoped to store)
router.use('/stores/:storeId/products', productRoutes);

// Category routes (scoped to store)
router.use('/stores/:storeId/categories', categoryRoutes);

// Cart routes
router.use('/stores/:storeId/cart', cartRoutes);

// Order routes
router.use('/stores/:storeId/orders', orderRoutes);

// Review routes
router.use('/stores/:storeId/reviews', reviewRoutes);

// Analytics routes
router.use('/stores/:storeId/analytics', analyticsRoutes);

// Return routes
router.use('/stores/:storeId/returns', returnRoutes);

// Coupon routes
router.use('/stores', couponRoutes);

// Shipping routes
router.use('/stores', shippingRoutes);

// Tax routes
router.use('/stores', taxRoutes);

// Loyalty routes
router.use('/stores', loyaltyRoutes);

// PWA routes
router.use('/stores', pwaRoutes);

// Inventory routes
router.use('/stores', inventoryRoutes);

// Bulk import/export routes
router.use('/stores', bulkRoutes);

// Variant routes
router.use('/stores', variantRoutes);

// Notification routes (admin + public push)
router.use('/stores', notificationRoutes);
router.use('/public', notificationRoutes);

// Wishlist routes (user-scoped)
router.use('/wishlist', wishlistRoutes);

// Address routes (user-scoped)
router.use('/addresses', addressRoutes);

export default router;
