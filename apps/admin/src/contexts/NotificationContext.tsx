'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '@/lib/auth';
import { getApiUrl } from '@/lib/api';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: Date;
  read: boolean;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  isConnected: boolean;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearNotifications: () => void;
  subscribeToStore: (storeId: string) => void;
  unsubscribeFromStore: (storeId: string) => void;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const subscribedStoresRef = useRef<Set<string>>(new Set());

  // Connect to WebSocket when user is authenticated
  useEffect(() => {
    if (!isAuthenticated || !user) {
      return;
    }

    const apiUrl = getApiUrl();

    socketRef.current = io(apiUrl, {
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
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

    socketRef.current.on('connect_error', error => {
      console.error('Socket connection error:', error.message);
    });

    return () => {
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

  const unreadCount = notifications.filter(n => !n.read).length;

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
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

const defaultNotificationContext: NotificationContextType = {
  notifications: [],
  unreadCount: 0,
  isConnected: false,
  markAsRead: () => {},
  markAllAsRead: () => {},
  clearNotifications: () => {},
  subscribeToStore: () => {},
  unsubscribeFromStore: () => {},
};

export function useNotifications() {
  const context = useContext(NotificationContext);
  return context ?? defaultNotificationContext;
}
