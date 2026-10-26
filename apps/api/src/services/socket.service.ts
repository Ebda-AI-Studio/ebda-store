import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { isPlatformOrigin } from '../lib/cors-cache';
import { withUser } from '@ebda/database';
import { getUserState } from '../lib/definer';
import { redis } from './redis.service';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
import { AppError } from '../middleware/error-handler';
import { JWT_AUDIENCES_ACCEPTED, JWT_ISSUERS_ACCEPTED, formatMoney, fromMinor } from '@ebda/shared';
import { isWorkers } from '../lib/runtime';
import { cfBindings, cfWaitUntil } from '../cf/bindings';
// UiRefreshEvent is defined in lib/socket-broadcast and re-exported; we inline
// the interface here to avoid a circular dependency
// (socket-broadcast → socket.service → socket-broadcast).
export interface UiRefreshEvent {
  name:
    | 'ui/journal-posted'
    | 'ui/journal-reversed'
    | 'ui/po-received'
    | 'ui/stock-adjusted'
    | 'ui/expense-posted'
    | 'ui/reorder-scanned'
    | 'ui/deadstock-scanned'
    | 'ui/anomaly-detected'
    | 'ui/insights-rollup-completed';
  data?: Record<string, unknown>;
}

import { isLegacyAdminToken } from '../lib/legacy-admin-token';

interface AuthPayload {
  userId: string;
  email: string;
  role: string;
  tv?: number;
  purpose?: string;
}

interface NotificationPayload {
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Workers: there is no socket.io server in the isolate. Rooms are Durable Objects
 * (cf/store-realtime.ts): `user:<id>` holds a user's WebSockets, `store:<id>` fans out to
 * the user DOs subscribed to the store. Delivery is best-effort and rides `waitUntil`,
 * so an emit never delays the response (same contract as the socket.io path).
 */
function realtimeEmit(
  room: { user: string } | { store: string },
  event: string,
  payload: unknown
): void {
  const ns = cfBindings()?.STORE_REALTIME;
  if (!ns) return;
  const call = (async () => {
    if ('user' in room) {
      const stub = ns.get(ns.idFromName(`user:${room.user}`)) as unknown as {
        deliver(a: { event: string; payload: unknown }): Promise<number>;
      };
      await stub.deliver({ event, payload });
    } else {
      const stub = ns.get(ns.idFromName(`store:${room.store}`)) as unknown as {
        emitStore(storeId: string, event: string, payload: unknown): Promise<number>;
      };
      await stub.emitStore(room.store, event, payload);
    }
  })().catch(err => logger.warn({ err, event }, '[realtime] emit failed (non-fatal)'));
  cfWaitUntil(call);
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
          // Reject requests with no origin (prevents sandboxed iframe attacks)
          if (!origin) return callback(null, false);

          // Reuse the SINGLE platform-origin allowlist shared with the Express
          // CORS handler + CSRF middleware (lib/cors-cache). This inline list
          // used to only cover webUrl/adminUrl + Vercel, so it dropped the
          // Orders PWA (orders.ebda.app) and the ebda.app
          // prod fallbacks + CF Worker previews → the admin/orders WebSocket
          // handshake failed CORS. Delegating here keeps the two configs from
          // ever drifting again.
          if (
            isPlatformOrigin(origin, {
              webUrl: config.webUrl,
              adminUrl: config.adminUrl,
              nodeEnv: config.nodeEnv,
            })
          ) {
            return callback(null, true);
          }

          // Same reasoning as the HTTP CORS handler in index.ts: a handshake
          // from an unrecognised origin is an expected client condition, not a
          // server fault. Socket.io does not route this through the Express
          // errorHandler, so it never reached Sentry from here — but it is the
          // same defect class, and leaving one call site throwing a bare Error
          // is how the pattern grows back.
          logger.debug({ origin }, '[Socket.io] handshake rejected: origin not allowed');
          callback(new AppError(403, 'CORS_ORIGIN_NOT_ALLOWED', `Origin ${origin} is not allowed`));
        },
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Wire the Redis pub/sub adapter so events emitted on one Railway replica
    // are fanned out to all connected clients across every replica.
    // Uses two dedicated ioredis connections (pub + sub) duplicated from the
    // existing client so we don't share a connection that's in subscriber mode.
    // Falls back gracefully to the in-process adapter when Redis is absent
    // (local dev without REDIS_URL) — logs a warning so it's visible in logs.
    const redisClient = redis.getClient();
    if (redisClient && redis.isAvailable()) {
      try {
        // ioredis requires separate pub/sub connections — .duplicate() inherits
        // the same config (URL, keyPrefix, retry strategy) without copying state.
        const pubClient = redisClient.duplicate();
        const subClient = redisClient.duplicate();
        this.io.adapter(createAdapter(pubClient, subClient));
        logger.info('[Socket.io] Redis adapter attached (multi-replica safe)');
      } catch (err) {
        logger.warn(
          { err },
          '[Socket.io] Failed to attach Redis adapter — falling back to in-process'
        );
      }
    } else {
      logger.warn(
        '[Socket.io] REDIS_URL not configured — using in-process adapter. ' +
          'Socket events will NOT propagate across multiple Railway replicas. ' +
          'Set REDIS_URL to enable horizontal scaling.'
      );
    }

    // Authentication middleware
    this.io.use(async (socket, next) => {
      try {
        // Check auth token, authorization header, or HTTP-only cookie
        let token =
          socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

        // Fall back to cookie (sent via withCredentials: true)
        if (!token && socket.handshake.headers.cookie) {
          const match = socket.handshake.headers.cookie.match(/(?:^|;\s*)token=([^;]*)/);
          if (match) token = match[1];
        }

        if (!token) {
          return next(new Error('Authentication required'));
        }

        // M1 fix: verify with full issuer + audience constraints so MFA
        // challenge tokens (audience:'ebda-mfa-challenge') and refresh tokens
        // (type:'refresh') are rejected. Previously the socket auth accepted
        // any JWT signed with our secret regardless of purpose/audience.
        const payload = jwt.verify(token, config.jwtSecret, {
          algorithms: ['HS256'],
          issuer: JWT_ISSUERS_ACCEPTED,
          audience: JWT_AUDIENCES_ACCEPTED,
        }) as AuthPayload & { jti?: string };

        // Belt-and-suspenders: reject tokens carrying a non-access purpose claim.
        // Real access tokens have no `purpose` field.
        if (payload.purpose && payload.purpose !== 'access') {
          return next(new Error('Invalid token purpose'));
        }
        // Identity stage 5: the admin namespace authenticates with identity-service tokens only.
        if (
          isLegacyAdminToken({
            role: payload.role,
            impersonatedBy: (payload as { impersonatedBy?: string }).impersonatedBy,
          })
        )
          return next(new Error('Use the account service'));

        // M1 fix: apply the same revocation checks as the HTTP authenticate
        // middleware. Fail-open on Redis unavailability (same as authenticate).
        //
        // Check 1: per-token JTI denylist
        if (payload.jti) {
          try {
            const denied = await redis.isJtiDenied(payload.jti);
            if (denied) {
              return next(new Error('Token has been revoked'));
            }
          } catch {
            // fail-open: Redis down → allow connection
          }
        }

        // Check 2: per-user token version (bulk revocation on logout-all /
        // password change). Read from Redis cache; fall back to DB on miss.
        try {
          const cachedTv = await redis.getUserTokenVersion(payload.userId);
          let currentTv: number;
          if (cachedTv === null) {
            const u = await getUserState(payload.userId);
            currentTv = u?.tokenVersion ?? 0;
            // Warm the cache so subsequent connections skip the DB lookup.
            await redis.setUserTokenVersion(payload.userId, currentTv);
          } else {
            currentTv = cachedTv;
          }
          if ((payload.tv ?? 0) < currentTv) {
            return next(new Error('Token has been revoked'));
          }
        } catch {
          // fail-open: DB/Redis unavailable → allow connection
        }

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

    logger.info({ email: maskEmail(user.email), socketId: socket.id }, 'User connected');

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
          // `stores` is under RLS: read AS the user (owner match), not contextless.
          const store = await withUser(user.userId, tx =>
            tx.store.findFirst({
              where: { id: storeId, ownerId: user.userId },
              select: { id: true },
            })
          );
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
      logger.info({ email: maskEmail(user.email), socketId: socket.id }, 'User disconnected');
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
    if (isWorkers) return realtimeEmit({ user: userId }, 'notification', notification);
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit('notification', notification);
  }

  /**
   * Send notification to all admins of a store
   */
  notifyStore(storeId: string, notification: NotificationPayload) {
    if (isWorkers) return realtimeEmit({ store: storeId }, 'notification', notification);
    if (!this.io) return;
    this.io.to(`store:${storeId}`).emit('notification', notification);
  }

  /**
   * Broadcast to all connected clients
   */
  broadcast(event: string, data: unknown) {
    // Workers: platform-wide broadcast has no caller and no room; not implemented there.
    if (isWorkers) return;
    if (!this.io) return;
    this.io.emit(event, data);
  }

  /**
   * Notification helpers for common events
   */
  newOrderNotification(
    storeId: string,
    order: {
      orderId?: string;
      orderNumber: string;
      total: number;
      customerName: string;
    }
  ) {
    // `data.url` lets the bell-icon click handler navigate straight
    // into the order detail page. Without it the merchant sees the
    // notification but has to manually go find the order.
    const url = order.orderId
      ? `/stores/${storeId}/orders/${order.orderId}`
      : `/stores/${storeId}/orders`;
    this.notifyStore(storeId, {
      type: 'new_order',
      title: 'New Order Received',
      message: `Order #${order.orderNumber} from ${order.customerName} - ${formatMoney(order.total, 'en')}`,
      data: { ...order, storeId, url },
      createdAt: new Date(),
    });
  }

  newReviewNotification(
    storeId: string,
    review: {
      reviewId?: string;
      productName: string;
      rating: number;
      customerName: string;
    }
  ) {
    this.notifyStore(storeId, {
      type: 'new_review',
      title: 'New Product Review',
      message: `${review.customerName} left a ${review.rating}-star review on ${review.productName}`,
      data: { ...review, storeId, url: `/stores/${storeId}/reviews` },
      createdAt: new Date(),
    });
  }

  newReturnNotification(
    storeId: string,
    returnRequest: {
      returnId?: string;
      returnNumber: string;
      orderNumber: string;
      customerName: string;
    }
  ) {
    const url = returnRequest.returnId
      ? `/stores/${storeId}/returns/${returnRequest.returnId}`
      : `/stores/${storeId}/returns`;
    this.notifyStore(storeId, {
      type: 'new_return',
      title: 'New Return Request',
      message: `Return request #${returnRequest.returnNumber} for order #${returnRequest.orderNumber} from ${returnRequest.customerName}`,
      data: { ...returnRequest, storeId, url },
      createdAt: new Date(),
    });
  }

  // lowStockNotification was removed (2026-06-14): it was dead code (0 callers) —
  // low-stock alerts are now delivered via the stock-low-stock-alert Inngest
  // cron which sends a branded bilingual email digest to the store owner.
  // WebSocket push is intentionally not re-added: merchants are not required to
  // have the admin open to receive stock alerts.

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
   * Broadcast a UI refresh signal to all admin clients in a store room.
   * Used by broadcastToStore() in lib/socket-broadcast.ts. Never throws.
   */
  broadcastUiRefresh(storeId: string, event: UiRefreshEvent): void {
    if (isWorkers) return realtimeEmit({ store: storeId }, 'ui-refresh', event);
    if (!this.io) return;
    this.io.to(`store:${storeId}`).emit('ui-refresh', event);
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
