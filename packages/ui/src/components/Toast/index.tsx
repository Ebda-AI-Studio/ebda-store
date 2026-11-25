'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

// ==========================================
// Toast Notification System
// ==========================================

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  /**
   * One inline action: a button (e.g. "Undo" after removing a cart line; runs, then closes the toast) or, with
   * `href`, a real link (e.g. "View cart" after an add; navigates, the toast closes).
   */
  action?: { label: string; onClick?: () => void; href?: string };
}

interface ToastContextValue {
  toasts: Toast[];
  /** Returns the toast's id, so a caller can retract it (an optimistic confirmation that the server then refused). */
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function ToastProvider({
  children,
  dismissLabel = 'Dismiss notification',
}: {
  children: React.ReactNode;
  /** The close button's name, in the page language (the storefront passes the Arabic one). */
  dismissLabel?: string;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: Toast = {
      ...toast,
      id,
      duration: toast.duration ?? 5000,
    };
    setToasts(prev => [...prev, newToast]);
    return id;
  }, []);

  const success = useCallback(
    (title: string, message?: string) => {
      addToast({ type: 'success', title, message });
    },
    [addToast]
  );

  const error = useCallback(
    (title: string, message?: string) => {
      addToast({ type: 'error', title, message, duration: 8000 });
    },
    [addToast]
  );

  const warning = useCallback(
    (title: string, message?: string) => {
      addToast({ type: 'warning', title, message });
    },
    [addToast]
  );

  const info = useCallback(
    (title: string, message?: string) => {
      addToast({ type: 'info', title, message });
    },
    [addToast]
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, success, error, warning, info }}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} dismissLabel={dismissLabel} />
    </ToastContext.Provider>
  );
}

// Toast Container Component
function ToastContainer({
  toasts,
  removeToast,
  dismissLabel,
}: {
  toasts: Toast[];
  removeToast: (id: string) => void;
  dismissLabel: string;
}) {
  return (
    <div
      // Hook for the storefront's sticky-bar lift (apps/web globals.css, UI rule 6).
      data-toast-region
      className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] md:bottom-4 end-4 z-50 flex flex-col gap-2 w-auto max-w-[280px] sm:max-w-sm pointer-events-none"
      aria-live="polite"
      aria-relevant="additions removals"
    >
      {toasts.map(toast => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onClose={() => removeToast(toast.id)}
          dismissLabel={dismissLabel}
        />
      ))}
    </div>
  );
}

// Individual Toast Component
function ToastItem({
  toast,
  onClose,
  dismissLabel,
}: {
  toast: Toast;
  onClose: () => void;
  dismissLabel: string;
}) {
  const duration = toast.duration && toast.duration > 0 ? toast.duration : 0;

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [duration, onClose]);

  const icons: Record<ToastType, React.ReactNode> = {
    success: (
      <svg
        className="w-5 h-5 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg
        className="w-5 h-5 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    warning: (
      <svg
        className="w-5 h-5 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
    ),
    info: (
      <svg
        className="w-5 h-5 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  };

  // IA-03 (W4): the theme's tokens, never palette hues (a mint toast is in none of the looks).
  // Success and info speak in the store's ink; error and warning keep their semantic inks.
  const styles: Record<ToastType, { container: string; icon: string; progress: string }> = {
    // Semantic tokens only (success/destructive/warning/info, each with its `-ink` for text on a
    // tint): a store's look can restyle them, and no palette colour is hard-coded here.
    success: {
      container: 'bg-background border-success/30',
      icon: 'text-success-ink bg-success/20',
      progress: 'bg-success',
    },
    error: {
      container: 'bg-background border-destructive/40',
      icon: 'text-destructive-ink bg-destructive/10',
      progress: 'bg-destructive',
    },
    warning: {
      container: 'bg-background border-warning/40',
      icon: 'text-warning-ink bg-warning/10',
      progress: 'bg-warning',
    },
    info: {
      container: 'bg-background border-info/30',
      icon: 'text-info-ink bg-info/20',
      progress: 'bg-info',
    },
  };

  const s = styles[toast.type];

  return (
    <div
      className={`
        pointer-events-auto relative overflow-hidden
        ${s.container}
        border rounded-[var(--radius,0.75rem)] shadow-lg
        flex items-start gap-2.5 p-3 sm:gap-3 sm:p-4
        animate-toast-in
      `}
      // A confirmation is a status the screen reader says politely; only a failure interrupts (role alert).
      role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}
    >
      {/* Icon */}
      <div className={`flex-shrink-0 rounded-full p-1 ${s.icon}`}>{icons[toast.type]}</div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm text-foreground">{toast.title}</p>
        {toast.message && (
          <p
            className={`text-sm text-muted-foreground mt-0.5 leading-relaxed [overflow-wrap:anywhere] ${
              // a success toast names a product (a long name must not run a toast tall); an error or
              // warning is read in full, never cut to two lines with the rest in a tooltip
              toast.type === 'success' ? 'line-clamp-2' : ''
            }`}
            title={toast.message}
          >
            {toast.message}
          </p>
        )}
      </div>

      {toast.action &&
        (toast.action.href ? (
          <a
            href={toast.action.href}
            onClick={() => {
              toast.action?.onClick?.();
              onClose();
            }}
            className="flex-shrink-0 inline-flex items-center min-h-11 px-2 text-sm font-semibold text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {toast.action.label}
          </a>
        ) : (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick?.();
              onClose();
            }}
            className="flex-shrink-0 min-h-11 px-2 text-sm font-semibold text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {toast.action.label}
          </button>
        ))}

      {/* Close button */}
      <button
        onClick={onClose}
        aria-label={dismissLabel}
        // a11y re-audit (stop4 probe): 16x16 was below rule (d); the -m-3 keeps the toast's size.
        className="-m-3 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center cursor-pointer text-muted-foreground hover:text-foreground transition-colors duration-150 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Auto-dismiss progress bar */}
      {duration > 0 && (
        <div
          className={`absolute bottom-0 start-0 h-0.5 ${s.progress} opacity-60`}
          style={{
            animation: `toast-progress ${duration}ms linear forwards`,
          }}
        />
      )}
    </div>
  );
}

// CSS — inject shimmer + toast-progress keyframes
const toastStyles = `
@keyframes shimmer {
  100% { transform: translateX(100%); }
}

@keyframes toast-progress {
  from { width: 100%; }
  to { width: 0%; }
}

/* Legacy class kept for backward compatibility */
@keyframes slide-in-right {
  from { transform: translateX(100%); opacity: 0; }
  to   { transform: translateX(0);    opacity: 1; }
}

.animate-slide-in-right {
  animation: slide-in-right 0.3s ease-out;
}
`;

export { toastStyles };
