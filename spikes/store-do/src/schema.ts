import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Hand-mirrors migrations/0001_core.sql (the SQL file is the source of truth for the DO).
export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('EGP'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    slug: text('slug').notNull(),
    price: integer('price').notNull(),
    compareAtPrice: integer('compare_at_price'),
    inventory: integer('inventory').notNull().default(0),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('active'),
    hasVariants: integer('has_variants', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  t => [
    uniqueIndex('products_store_slug').on(t.storeId, t.slug),
    index('products_store_status_created').on(t.storeId, t.status, t.createdAt),
  ]
);

export const productVariants = sqliteTable('product_variants', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull(),
  productId: text('product_id').notNull(),
  sku: text('sku'),
  price: integer('price').notNull(),
  inventory: integer('inventory').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const carts = sqliteTable(
  'carts',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    sessionId: text('session_id').notNull(),
    status: text('status', { enum: ['active', 'converted', 'abandoned'] })
      .notNull()
      .default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  t => [uniqueIndex('carts_store_session').on(t.storeId, t.sessionId)]
);

export const cartItems = sqliteTable('cart_items', {
  id: text('id').primaryKey(),
  cartId: text('cart_id').notNull(),
  storeId: text('store_id').notNull(),
  productId: text('product_id').notNull(),
  variantId: text('variant_id'),
  quantity: integer('quantity').notNull(),
  unitPrice: integer('unit_price').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    orderNumber: integer('order_number').notNull(),
    cartId: text('cart_id'),
    status: text('status', { enum: ['pending', 'confirmed', 'cancelled', 'refunded'] })
      .notNull()
      .default('pending'),
    paymentMethod: text('payment_method', { enum: ['cod', 'instapay', 'card'] }).notNull(),
    subtotal: integer('subtotal').notNull(),
    total: integer('total').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  t => [uniqueIndex('orders_store_number').on(t.storeId, t.orderNumber)]
);

export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  storeId: text('store_id').notNull(),
  productId: text('product_id').notNull(),
  variantId: text('variant_id'),
  quantity: integer('quantity').notNull(),
  unitPrice: integer('unit_price').notNull(),
});
