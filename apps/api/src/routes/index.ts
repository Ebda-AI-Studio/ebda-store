import { Router } from 'express';
import authRoutes from './auth.routes';
import storeRoutes from './store.routes';
import productRoutes from './product.routes';
import cartRoutes from './cart.routes';
import orderRoutes from './order.routes';
import publicRoutes from './public.routes';
import paymentRoutes from './payment.routes';
import aiRoutes from './ai.routes';
import uploadRoutes from './upload.routes';
import adminRoutes from './admin.routes';

const router = Router();

// Public routes (no auth required)
router.use('/', publicRoutes);
router.use('/auth', authRoutes);

// Payment routes
router.use('/payments', paymentRoutes);

// AI routes (Force AI)
router.use('/ai', aiRoutes);

// Upload routes
router.use('/uploads', uploadRoutes);

// Admin routes (super_admin only)
router.use('/admin', adminRoutes);

// Store routes
router.use('/stores', storeRoutes);

// Product routes (scoped to store)
router.use('/stores/:storeId/products', productRoutes);

// Cart routes
router.use('/stores/:storeId/cart', cartRoutes);

// Order routes
router.use('/stores/:storeId/orders', orderRoutes);

export default router;
