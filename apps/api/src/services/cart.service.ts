import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

export class CartService {
  static async getOrCreate(storeId: string, sessionId: string, customerId?: string) {
    let cart = await prisma.cart.findFirst({
      where: {
        storeId,
        OR: [{ sessionId }, ...(customerId ? [{ customerId }] : [])],
      },
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

    if (!cart) {
      cart = await prisma.cart.create({
        data: {
          storeId,
          sessionId,
          customerId,
        },
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
    // Verify product exists and is active
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, status: 'active' },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found or unavailable');
    }

    // Check inventory
    if (product.trackInventory && product.inventory < quantity) {
      throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
    }

    // Get or create cart
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    // Check if item already exists
    const existingItem = await prisma.cartItem.findFirst({
      where: { cartId: cart.id, productId },
    });

    if (existingItem) {
      const newQuantity = existingItem.quantity + quantity;

      if (product.trackInventory && product.inventory < newQuantity) {
        throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
      }

      await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: newQuantity },
      });
    } else {
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          quantity,
        },
      });
    }

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
      if (item.product.trackInventory && item.product.inventory < quantity) {
        throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
      }

      await prisma.cartItem.update({
        where: { id: itemId },
        data: { quantity },
      });
    }

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

    return this.getOrCreate(storeId, sessionId, customerId);
  }

  static async clear(storeId: string, sessionId: string, customerId?: string) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId);

    await prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
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
