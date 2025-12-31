import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';

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
        origin: [config.webUrl, config.adminUrl],
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Authentication middleware
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

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

    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    console.log('🔌 Socket.io initialized');
    return this.io;
  }

  /**
   * Handle new socket connection
   */
  private handleConnection(socket: Socket) {
    const user = socket.data.user as AuthPayload;

    // Add socket to user's sockets
    this.addUserSocket(user.userId, socket.id);

    console.log(`User ${user.email} connected (socket: ${socket.id})`);

    // Join user's room
    socket.join(`user:${user.userId}`);

    // Handle store subscription
    socket.on('subscribe:store', (storeId: string) => {
      socket.join(`store:${storeId}`);
      this.addStoreSocket(storeId, socket.id);
      console.log(`Socket ${socket.id} subscribed to store:${storeId}`);
    });

    socket.on('unsubscribe:store', (storeId: string) => {
      socket.leave(`store:${storeId}`);
      this.removeStoreSocket(storeId, socket.id);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      this.removeUserSocket(user.userId, socket.id);
      this.removeAllStoreSockets(socket.id);
      console.log(`User ${user.email} disconnected (socket: ${socket.id})`);
    });

    // Handle errors
    socket.on('error', (error) => {
      console.error(`Socket error for user ${user.userId}:`, error);
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
  newOrderNotification(storeId: string, order: { orderNumber: string; total: number; customerName: string }) {
    this.notifyStore(storeId, {
      type: 'new_order',
      title: 'New Order Received',
      message: `Order #${order.orderNumber} from ${order.customerName} - ${(order.total / 1000).toFixed(3)} KWD`,
      data: order,
      createdAt: new Date(),
    });
  }

  newReviewNotification(storeId: string, review: { productName: string; rating: number; customerName: string }) {
    this.notifyStore(storeId, {
      type: 'new_review',
      title: 'New Product Review',
      message: `${review.customerName} left a ${review.rating}-star review on ${review.productName}`,
      data: review,
      createdAt: new Date(),
    });
  }

  newReturnNotification(storeId: string, returnRequest: { returnNumber: string; orderNumber: string; customerName: string }) {
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

  returnStatusNotification(userId: string, returnRequest: { returnNumber: string; status: string }) {
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
}

// Export singleton instance
export const socketService = new SocketService();
