import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';
import { retryOnWriteConflict } from '../lib/db-retry';

export class CartService {
  static async getOrCreate(storeId: string, sessionId: string, customerId?: string) {
    // Shared include fragment to avoid repetition
    const cartInclude = {
      items: {
        include: {
          product: {
            include: { images: { take: 1, orderBy: { position: 'asc' } } },
          },
        },
      },
    } as const;

    // Try to find an existing cart for this session (or customer).
    //
    // orderBy: updatedAt desc — when a customer logs in mid-session,
    // BOTH their fresh session cart AND their older customer cart may
    // match the OR clause. Without an explicit order, Postgres returns
    // either at random which can resurrect an empty stale cart and
    // cause a spurious EMPTY_CART on POST /orders. Returning the
    // most-recently-touched cart matches the user's mental model
    // ("my current cart") and prevents the test-order-cancel flakiness.
    let cart = await prisma.cart.findFirst({
      where: {
        storeId,
        OR: [{ sessionId }, ...(customerId ? [{ customerId }] : [])],
      },
      include: cartInclude,
      orderBy: { updatedAt: 'desc' },
    });

    if (!cart) {
      try {
        // Attempt to create — a concurrent request may have already created one,
        // in which case we catch the unique constraint violation and fall back to
        // a findFirst so we never return two carts for the same session.
        cart = await prisma.cart.create({
          data: {
            storeId,
            sessionId,
            customerId,
          },
          include: cartInclude,
        });
      } catch (err) {
        // P2002 = Prisma unique constraint violation
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const existing = await prisma.cart.findFirst({
            where: {
              storeId,
              OR: [{ sessionId }, ...(customerId ? [{ customerId }] : [])],
            },
            include: cartInclude,
          });
          if (!existing) {
            throw err; // Unexpected — re-throw
          }
          cart = existing;
        } else {
          throw err;
        }
      }
    }

    // Calculate totals
    const subtotal = cart.items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

    return { ...cart, subtotal };
  }

  static async addItem(
    storeId: string,
    sessionId: string,
    productId: string,
    quantity: number = 1,
    customerId?: string,
    variantId?: string
  ) {
    // Get or create cart first (outside transaction since getOrCreate has its own retry logic)
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    // Resolve the backorder feature flag before entering the transaction.
    // When disabled, per-product allowBackorder flags are ignored — out-of-stock
    // items are rejected at the cart level, preventing backorder lines from
    // ever reaching order creation.
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      storeId,
      'inventory.backorder'
    );

    // Wrap the inventory check + cart item creation in a serializable transaction
    // to prevent a TOCTOU race where two concurrent addItem calls both pass the
    // inventory check before either has written. Note: the definitive inventory
    // lock happens at order creation time (SELECT ... FOR UPDATE in order.service),
    // but this transaction reduces the window for overselling at cart level.
    //
    // Serializable isolation aborts conflicting transactions with P2034 under
    // concurrency (e.g. many shoppers adding the same hot product at once). The
    // retry wrapper turns those transient conflicts into a brief backoff+retry
    // instead of a 500 — without it a load test surfaced ~18% failures on a hot
    // product. Business errors (INSUFFICIENT_INVENTORY, NOT_FOUND) are not P2034
    // so they propagate immediately and are never retried.
    await retryOnWriteConflict(
      () =>
        prisma.$transaction(
          async tx => {
            // Verify product exists and is active
            const product = await tx.product.findFirst({
              where: { id: productId, storeId, status: 'active' },
            });

            if (!product) {
              throw new AppError(404, 'NOT_FOUND', 'Product not found or unavailable');
            }

            // Resolve the chosen variant — it must belong to this product and
            // be active. Variant stock + backorder override the product values,
            // and the line is keyed by (cartId, productId, variantId) so each
            // variant is its own row (order.service already reads variantId).
            let variant: { id: string; inventory: number; allowBackorder: boolean } | null = null;
            if (variantId) {
              variant = await tx.productVariant.findFirst({
                where: { id: variantId, productId, isActive: true },
                select: { id: true, inventory: true, allowBackorder: true },
              });
              if (!variant) {
                throw new AppError(404, 'NOT_FOUND', 'Variant not found or unavailable');
              }
            }

            const availableInventory = variant ? variant.inventory : product.inventory;
            const effectiveAllowBackorder =
              backorderFeatureEnabled &&
              (variant ? variant.allowBackorder : product.allowBackorder);

            // Same product+variant line if it already exists (null variantId for
            // base-product lines merges only with other base-product lines).
            const existingItem = await tx.cartItem.findFirst({
              where: { cartId: cart.id, productId, variantId: variantId ?? null },
            });

            if (existingItem) {
              const newQuantity = existingItem.quantity + quantity;

              if (
                product.trackInventory &&
                availableInventory < newQuantity &&
                !effectiveAllowBackorder
              ) {
                throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
              }

              await tx.cartItem.update({
                where: { id: existingItem.id },
                data: { quantity: newQuantity },
              });
            } else {
              if (
                product.trackInventory &&
                availableInventory < quantity &&
                !effectiveAllowBackorder
              ) {
                throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
              }

              // A concurrent add of the same line to the SAME cart can lose the
              // (cartId, productId, variantId) unique race → P2002. Under
              // Serializable that surfaced as P2034 and was retried; under Read
              // Committed it's P2002, so the retry wrapper below is told to retry
              // P2002 too — on the re-run findFirst sees the winner's row and the
              // existing-branch above merges the quantity.
              await tx.cartItem.create({
                data: { cartId: cart.id, productId, variantId: variantId ?? null, quantity },
              });
            }
          },
          {
            // Advisory cart-level check only — the authoritative inventory lock
            // is the atomic decrement at order creation (order.service). Read
            // Committed avoids the spurious P2034 storm where concurrent adds of
            // the SAME product (each writing its OWN cart row) conflicted purely
            // because they read the same product.inventory row under Serializable.
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          }
        ),
      { label: 'cart.addItem', extraRetryCodes: ['P2002'] }
    );

    // Track activity for abandonment detection
    await prisma.cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId);
  }

  static async addItems(
    storeId: string,
    sessionId: string,
    items: Array<{ productId: string; quantity: number; variantId?: string }>,
    customerId?: string
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    if (items.length === 0) {
      return cart;
    }

    // Resolve the backorder feature flag before the transaction (same reason as addItem).
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      storeId,
      'inventory.backorder'
    );

    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, storeId, status: 'active' },
      select: { id: true, inventory: true, trackInventory: true, allowBackorder: true },
    });
    const productById = new Map(products.map(p => [p.id, p]));

    // Resolve any chosen variants up front (must belong to one of these products
    // and be active). Variant stock/backorder override the product values.
    const variantIds = items.map(i => i.variantId).filter((v): v is string => !!v);
    const variants = variantIds.length
      ? await prisma.productVariant.findMany({
          where: { id: { in: variantIds }, productId: { in: productIds }, isActive: true },
          select: { id: true, inventory: true, allowBackorder: true },
        })
      : [];
    const variantById = new Map(variants.map(v => [v.id, v]));
    const lineKey = (productId: string, variantId?: string | null) =>
      `${productId}::${variantId ?? ''}`;

    await retryOnWriteConflict(
      () =>
        prisma.$transaction(
          async tx => {
            const existingItems = await tx.cartItem.findMany({
              where: { cartId: cart.id, productId: { in: productIds } },
            });
            const existingByLine = new Map(
              existingItems.map(i => [lineKey(i.productId, i.variantId), i])
            );

            for (const item of items) {
              const product = productById.get(item.productId);
              if (!product) continue;
              // A chosen-but-invalid variant is skipped, not silently dropped to
              // the base product (which would be the wrong cart line).
              if (item.variantId && !variantById.has(item.variantId)) continue;
              const variant = item.variantId ? variantById.get(item.variantId)! : null;

              const existing = existingByLine.get(lineKey(item.productId, item.variantId));
              const targetQuantity = (existing?.quantity ?? 0) + item.quantity;

              const availableInventory = variant ? variant.inventory : product.inventory;
              const effectiveAllowBackorder =
                backorderFeatureEnabled &&
                (variant ? variant.allowBackorder : product.allowBackorder);

              if (
                product.trackInventory &&
                availableInventory < targetQuantity &&
                !effectiveAllowBackorder
              ) {
                throw new AppError(
                  400,
                  'INSUFFICIENT_INVENTORY',
                  `Not enough inventory for product ${item.productId}`
                );
              }

              if (existing) {
                await tx.cartItem.update({
                  where: { id: existing.id },
                  data: { quantity: targetQuantity },
                });
              } else {
                // Same-cart unique race → P2002, retried at the tx level (see
                // addItem + the extraRetryCodes below).
                await tx.cartItem.create({
                  data: {
                    cartId: cart.id,
                    productId: item.productId,
                    variantId: item.variantId ?? null,
                    quantity: item.quantity,
                  },
                });
              }
            }
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
        ),
      { label: 'cart.addItems', extraRetryCodes: ['P2002'] }
    );

    await prisma.cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId);
  }

  static async updateItem(
    storeId: string,
    sessionId: string,
    itemId: string,
    quantity: number,
    customerId?: string
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    // Resolve the backorder feature flag before the inventory check.
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      storeId,
      'inventory.backorder'
    );

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId, cartId: cart.id },
      include: { product: true },
    });

    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Cart item not found');
    }

    if (quantity <= 0) {
      await prisma.cartItem.delete({ where: { id: itemId } });
    } else {
      const effectiveAllowBackorder = backorderFeatureEnabled && item.product.allowBackorder;
      if (
        item.product.trackInventory &&
        item.product.inventory < quantity &&
        !effectiveAllowBackorder
      ) {
        throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
      }

      await prisma.cartItem.update({
        where: { id: itemId },
        data: { quantity },
      });
    }

    // Track activity for abandonment detection
    await prisma.cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId);
  }

  static async removeItem(storeId: string, sessionId: string, itemId: string, customerId?: string) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId, cartId: cart.id },
    });

    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Cart item not found');
    }

    await prisma.cartItem.delete({ where: { id: itemId } });

    // Track activity for abandonment detection
    await prisma.cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId);
  }

  static async clear(storeId: string, sessionId: string, customerId?: string) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    await prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });

    // Track activity for abandonment detection
    await prisma.cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId);
  }

  static async mergeGuestCart(storeId: string, guestSessionId: string, customerId: string) {
    const [guestCart, userCart] = await Promise.all([
      prisma.cart.findFirst({
        where: { storeId, sessionId: guestSessionId, customerId: null },
        include: { items: true },
      }),
      prisma.cart.findFirst({
        where: { storeId, customerId },
        include: { items: true },
      }),
    ]);

    if (!guestCart || guestCart.items.length === 0) {
      return userCart;
    }

    // Create user cart if doesn't exist
    const targetCart =
      userCart ||
      (await prisma.cart.create({
        data: { storeId, sessionId: guestSessionId, customerId },
      }));

    // Merge items
    for (const guestItem of guestCart.items) {
      const existingItem = userCart?.items.find(item => item.productId === guestItem.productId);

      if (existingItem) {
        await prisma.cartItem.update({
          where: { id: existingItem.id },
          data: { quantity: existingItem.quantity + guestItem.quantity },
        });
      } else {
        await prisma.cartItem.create({
          data: {
            cartId: targetCart.id,
            productId: guestItem.productId,
            quantity: guestItem.quantity,
          },
        });
      }
    }

    // Delete guest cart
    await prisma.cart.delete({ where: { id: guestCart.id } });

    return prisma.cart.findUnique({
      where: { id: targetCart.id },
      include: {
        items: {
          include: {
            product: {
              include: { images: { take: 1, orderBy: { position: 'asc' } } },
            },
          },
        },
      },
    });
  }
}
