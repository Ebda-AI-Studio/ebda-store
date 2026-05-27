import { prisma, Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

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
    customerId?: string
  ) {
    // Get or create cart first (outside transaction since getOrCreate has its own retry logic)
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    // Wrap the inventory check + cart item creation in a serializable transaction
    // to prevent a TOCTOU race where two concurrent addItem calls both pass the
    // inventory check before either has written. Note: the definitive inventory
    // lock happens at order creation time (SELECT ... FOR UPDATE in order.service),
    // but this transaction reduces the window for overselling at cart level.
    await prisma.$transaction(
      async tx => {
        // Verify product exists and is active
        const product = await tx.product.findFirst({
          where: { id: productId, storeId, status: 'active' },
        });

        if (!product) {
          throw new AppError(404, 'NOT_FOUND', 'Product not found or unavailable');
        }

        // Check if item already exists
        const existingItem = await tx.cartItem.findFirst({
          where: { cartId: cart.id, productId },
        });

        if (existingItem) {
          const newQuantity = existingItem.quantity + quantity;

          if (
            product.trackInventory &&
            product.inventory < newQuantity &&
            !product.allowBackorder
          ) {
            throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
          }

          await tx.cartItem.update({
            where: { id: existingItem.id },
            data: { quantity: newQuantity },
          });
        } else {
          // Check inventory for new item
          if (product.trackInventory && product.inventory < quantity && !product.allowBackorder) {
            throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
          }

          await tx.cartItem.create({
            data: {
              cartId: cart.id,
              productId,
              quantity,
            },
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }
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
    items: Array<{ productId: string; quantity: number }>,
    customerId?: string
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    if (items.length === 0) {
      return cart;
    }

    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, storeId, status: 'active' },
      select: { id: true, inventory: true, trackInventory: true, allowBackorder: true },
    });
    const productById = new Map(products.map(p => [p.id, p]));

    await prisma.$transaction(
      async tx => {
        const existingItems = await tx.cartItem.findMany({
          where: { cartId: cart.id, productId: { in: productIds } },
        });
        const existingByProduct = new Map(existingItems.map(i => [i.productId, i]));

        for (const item of items) {
          const product = productById.get(item.productId);
          if (!product) continue;

          const existing = existingByProduct.get(item.productId);
          const targetQuantity = (existing?.quantity ?? 0) + item.quantity;

          if (
            product.trackInventory &&
            product.inventory < targetQuantity &&
            !product.allowBackorder
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
            await tx.cartItem.create({
              data: { cartId: cart.id, productId: item.productId, quantity: item.quantity },
            });
          }
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
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
      if (
        item.product.trackInventory &&
        item.product.inventory < quantity &&
        !item.product.allowBackorder
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
