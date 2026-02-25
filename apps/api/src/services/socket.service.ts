import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '@force/database';
import logger from '../lib/logger';

interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}

interface NotificationPayload {
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: Date;
}

class SocketService {
  private io: Server | null = null;
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> socketIds
  private storeSockets: Map<string, Set<string>> = new Map(); // storeId -> socketIds

  /**
   * Initialize Socket.io with the HTTP server
   */
  initialize(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: (origin, callback) => {
          // Allow requests with no origin
          if (!origin) return callback(null, true);

          // Always allow platform URLs
          const platformOrigins = [config.webUrl, config.adminUrl].filter(Boolean);
          if (platformOrigins.includes(origin)) return callback(null, true);

          // Allow Vercel preview/production deployments
          if (
            origin.endsWith('.vercel.app') &&
            (origin.includes('force-web') || origin.includes('force-admin'))
          ) {
            return callback(null, true);
          }

          // Allow localhost in development
          if (config.nodeEnv !== 'production' && origin.includes('localhost')) {
            return callback(null, true);
          }

          callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Authentication middleware
    this.io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

        if (!token) {
          return next(new Error('Authentication required'));
        }

        const payload = jwt.verify(token, config.jwtSecret) as AuthPayload;
        socket.data.user = payload;
        next();
      } catch {
        next(new Error('Invalid token'));
      }
    });

    this.io.on('connection', socket => {
      this.handleConnection(socket);
    });

    logger.info('Socket.io initialized');
    return this.io;
  }

  /**
   * Handle new socket connection
   */
  private handleConnection(socket: Socket) {
    const user = socket.data.user as AuthPayload;

    // Add socket to user's sockets
    this.addUserSocket(user.userId, socket.id);

    logger.info({ email: user.email, socketId: socket.id }, 'User connected');

    // Join user's room
    socket.join(`user:${user.userId}`);

    // Handle store subscription (only admins can subscribe to store events)
    socket.on('subscribe:store', async (storeId: string) => {
      const role = user.role;
      if (role !== 'store_admin' && role !== 'super_admin') {
        socket.emit('error', { message: 'Insufficient permissions to subscribe to store events' });
        return;
      }

      // store_admin can only subscribe to their own store
      if (role === 'store_admin') {
        try {
          const store = await prisma.store.findFirst({
            where: { id: storeId, ownerId: user.userId },
            select: { id: true },
          });
          if (!store) {
            socket.emit('error', { message: 'You do not have access to this store' });
            return;
          }
        } catch {
          socket.emit('error', { message: 'Failed to verify store access' });
          return;
        }
      }

      socket.join(`store:${storeId}`);
      this.addStoreSocket(storeId, socket.id);
    });

    socket.on('unsubscribe:store', (storeId: string) => {
      socket.leave(`store:${storeId}`);
      this.removeStoreSocket(storeId, socket.id);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      this.removeUserSocket(user.userId, socket.id);
      this.removeAllStoreSockets(socket.id);
      logger.info({ email: user.email, socketId: socket.id }, 'User disconnected');
    });

    // Handle errors
    socket.on('error', error => {
      logger.error({ userId: user.userId, err: error }, 'Socket error');
    });
  }

  /**
   * Socket tracking helpers
   */
  private addUserSocket(userId: string, socketId: string) {
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(socketId);
  }

  private removeUserSocket(userId: string, socketId: string) {
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }
  }

  private addStoreSocket(storeId: string, socketId: string) {
    if (!this.storeSockets.has(storeId)) {
      this.storeSockets.set(storeId, new Set());
    }
    this.storeSockets.get(storeId)!.add(socketId);
  }

  private removeStoreSocket(storeId: string, socketId: string) {
    const sockets = this.storeSockets.get(storeId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.storeSockets.delete(storeId);
      }
    }
  }

  private removeAllStoreSockets(socketId: string) {
    for (const [storeId, sockets] of this.storeSockets.entries()) {
      if (sockets.has(socketId)) {
        sockets.delete(socketId);
        if (sockets.size === 0) {
          this.storeSockets.delete(storeId);
        }
      }
    }
  }

  /**
   * Send notification to a specific user
   */
  notifyUser(userId: string, notification: NotificationPayload) {
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit('notification', notification);
  }

  /**
   * Send notification to all admins of a store
   */
  notifyStore(storeId: string, notification: NotificationPayload) {
    if (!this.io) return;
    this.io.to(`store:${storeId}`).emit('notification', notification);
  }

  /**
   * Broadcast to all connected clients
   */
  broadcast(event: string, data: unknown) {
    if (!this.io) return;
    this.io.emit(event, data);
  }

  /**
   * Notification helpers for common events
   */
  newOrderNotification(
    storeId: string,
    order: { orderNumber: string; total: number; customerName: string }
  ) {
    this.notifyStore(storeId, {
      type: 'new_order',
      title: 'New Order Received',
      message: `Order #${order.orderNumber} from ${order.customerName} - ${(order.total / 1000).toFixed(3)} KWD`,
      data: order,
      createdAt: new Date(),
    });
  }

  newReviewNotification(
    storeId: string,
    review: { productName: string; rating: number; customerName: string }
  ) {
    this.notifyStore(storeId, {
      type: 'new_review',
      title: 'New Product Review',
      message: `${review.customerName} left a ${review.rating}-star review on ${review.productName}`,
      data: review,
      createdAt: new Date(),
    });
  }

  newReturnNotification(
    storeId: string,
    returnRequest: { returnNumber: string; orderNumber: string; customerName: string }
  ) {
    this.notifyStore(storeId, {
      type: 'new_return',
      title: 'New Return Request',
      message: `Return request #${returnRequest.returnNumber} for order #${returnRequest.orderNumber} from ${returnRequest.customerName}`,
      data: returnRequest,
      createdAt: new Date(),
    });
  }

  lowStockNotification(storeId: string, product: { name: string; inventory: number }) {
    this.notifyStore(storeId, {
      type: 'low_stock',
      title: 'Low Stock Alert',
      message: `${product.name} has only ${product.inventory} items left in stock`,
      data: product,
      createdAt: new Date(),
    });
  }

  orderStatusNotification(userId: string, order: { orderNumber: string; status: string }) {
    this.notifyUser(userId, {
      type: 'order_status',
      title: 'Order Status Updated',
      message: `Your order #${order.orderNumber} is now ${order.status}`,
      data: order,
      createdAt: new Date(),
    });
  }

  returnStatusNotification(
    userId: string,
    returnRequest: { returnNumber: string; status: string }
  ) {
    this.notifyUser(userId, {
      type: 'return_status',
      title: 'Return Status Updated',
      message: `Your return request #${returnRequest.returnNumber} is now ${returnRequest.status}`,
      data: returnRequest,
      createdAt: new Date(),
    });
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      connectedUsers: this.userSockets.size,
      connectedStores: this.storeSockets.size,
      totalSockets: this.io?.sockets.sockets.size || 0,
    };
  }

  /**
   * Close all socket connections
   */
  close(): void {
    if (this.io) {
      this.io.close();
      this.io = null;
      this.userSockets.clear();
      this.storeSockets.clear();
    }
  }
}

// Export singleton instance
export const socketService = new SocketService();
