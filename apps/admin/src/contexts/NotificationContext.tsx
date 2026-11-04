'use client';

import { getFreshAccessToken } from '../lib/api';
import { makeSocketAuth } from '../lib/socket-auth';
import { handleSessionEnded } from '../lib/session-ended';
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import type { Socket } from 'socket.io-client';
import { useAuth } from '@/lib/auth';
import { getApiUrl } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: Date;
  read: boolean;
}

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

type RefreshCallback = (event: UiRefreshEvent) => void;

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  isConnected: boolean;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearNotifications: () => void;
  subscribeToStore: (storeId: string) => void;
  unsubscribeFromStore: (storeId: string) => void;
  /** Register a callback for a specific ui-refresh event name. Returns cleanup fn. */
  registerRefreshCallback: (eventName: UiRefreshEvent['name'], cb: RefreshCallback) => () => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const NotificationContext = createContext<NotificationContextType | null>(null);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const subscribedStoresRef = useRef<Set<string>>(new Set());

  // Map of event-name → list of callbacks registered by pages via useUiRefresh
  const refreshCallbacksRef = useRef<Map<string, RefreshCallback[]>>(new Map());

  // Connect to WebSocket when user is authenticated
  useEffect(() => {
    if (!isAuthenticated || !user) {
      return;
    }

    const apiUrl = getApiUrl();
    let cancelled = false;

    // Dynamically import socket.io-client to keep it out of the initial bundle
    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;

      // socket.io calls `auth` on EVERY (re)connect, so each attempt takes a fresh token from the same source as the rest
      // of the app (P0 logout audit): never `localStorage.accessToken` (absent after an accounts sign-in), and a revoked
      // session stops the socket for good and ends the session visibly.
      // WebSocket only: on Cloudflare the API's realtime is a Durable Object that speaks the Socket.IO protocol over a
      // plain WebSocket (no long-polling session). `uid` routes the socket to the user's Durable Object.
      socketRef.current = io(apiUrl, {
        transports: ['websocket'],
        query: { uid: user.id },
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: 20,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        auth: makeSocketAuth({
          getToken: () => getFreshAccessToken(),
          onRevoked: () => {
            const sock = socketRef.current;
            if (sock) {
              sock.io.opts.reconnection = false;
              sock.disconnect();
            }
            handleSessionEnded();
          },
        }),
      });

      socketRef.current.on('connect', () => {
        setIsConnected(true);

        // Resubscribe to stores on reconnect
        subscribedStoresRef.current.forEach(storeId => {
          socketRef.current?.emit('subscribe:store', storeId);
        });
      });

      socketRef.current.on('disconnect', () => {
        setIsConnected(false);
      });

      socketRef.current.on('notification', (notification: Omit<Notification, 'id' | 'read'>) => {
        const newNotification: Notification = {
          ...notification,
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          read: false,
          createdAt: new Date(notification.createdAt),
        };

        setNotifications(prev => [newNotification, ...prev].slice(0, 50)); // Keep last 50
      });

      // UI refresh signals — pages register callbacks via useUiRefresh
      socketRef.current.on('ui-refresh', (event: UiRefreshEvent) => {
        const callbacks = refreshCallbacksRef.current.get(event.name) ?? [];
        callbacks.forEach(cb => cb(event));
      });

      socketRef.current.on('connect_error', error => {
        console.error('Socket connection error:', error.message);
      });
    }); // end dynamic import .then()

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [isAuthenticated, user]);

  const subscribeToStore = useCallback((storeId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('subscribe:store', storeId);
    }
    subscribedStoresRef.current.add(storeId);
  }, []);

  const unsubscribeFromStore = useCallback((storeId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('unsubscribe:store', storeId);
    }
    subscribedStoresRef.current.delete(storeId);
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const registerRefreshCallback = useCallback(
    (eventName: UiRefreshEvent['name'], cb: RefreshCallback): (() => void) => {
      const map = refreshCallbacksRef.current;
      if (!map.has(eventName)) map.set(eventName, []);
      map.get(eventName)!.push(cb);
      // Return a cleanup function
      return () => {
        const list = map.get(eventName);
        if (!list) return;
        const idx = list.indexOf(cb);
        if (idx !== -1) list.splice(idx, 1);
      };
    },
    []
  );

  const unreadCount = useMemo(() => notifications.filter(n => !n.read).length, [notifications]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        isConnected,
        markAsRead,
        markAllAsRead,
        clearNotifications,
        subscribeToStore,
        unsubscribeFromStore,
        registerRefreshCallback,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

const defaultNotificationContext: NotificationContextType = {
  notifications: [],
  unreadCount: 0,
  isConnected: false,
  markAsRead: () => {},
  markAllAsRead: () => {},
  clearNotifications: () => {},
  subscribeToStore: () => {},
  unsubscribeFromStore: () => {},
  registerRefreshCallback: () => () => {},
};

export function useNotifications() {
  const context = useContext(NotificationContext);
  return context ?? defaultNotificationContext;
}

/**
 * Subscribe to a ui-refresh event from the server. Callback fires whenever
 * the server broadcasts the named event to this store's room.
 *
 * Usage:
 *   useUiRefresh('ui/journal-posted', () => { setRefreshKey(k => k + 1); });
 */
export function useUiRefresh(
  eventName: UiRefreshEvent['name'],
  callback: (event: UiRefreshEvent) => void
) {
  const { registerRefreshCallback } = useNotifications();

  useEffect(() => {
    const cleanup = registerRefreshCallback(eventName, callback);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName, registerRefreshCallback]);
  // NOTE: `callback` intentionally excluded — callers should pass a stable ref
  // (useCallback) or accept that re-registration happens on every render.
  // For the journal page this is a one-time mount, so it doesn't matter.
}
