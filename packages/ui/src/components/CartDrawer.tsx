'use client';

import { forwardRef, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../utils/cn';
import { Button } from './Button';
import { Price } from './Price';
import { QuantitySelector } from './QuantitySelector';

export interface CartItem {
  id: string;
  productId: string;
  name: string;
  nameAr?: string;
  price: number;
  quantity: number;
  image?: string;
  variant?: string;
  variantAr?: string;
  maxQuantity?: number;
}

export interface CartDrawerProps {
  /** Whether the drawer is open */
  isOpen: boolean;
  /** Callback to close the drawer */
  onClose: () => void;
  /** Cart items */
  items: CartItem[];
  /** Callback when item quantity changes */
  onUpdateQuantity: (itemId: string, quantity: number) => void;
  /** Callback when item is removed */
  onRemoveItem: (itemId: string) => void;
  /** Callback when checkout is clicked */
  onCheckout: () => void;
  /** Currency code */
  currency?: string;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Custom labels */
  labels?: Partial<{
    title: string;
    emptyCart: string;
    emptyCartCta: string;
    subtotal: string;
    shipping: string;
    shippingNote: string;
    checkout: string;
    continueShopping: string;
    remove: string;
  }>;
  /** Link to continue shopping */
  continueShoppingHref?: string;
  /** Loading state */
  isLoading?: boolean;
}

const defaultLabelsEn = {
  title: 'Your Cart',
  emptyCart: 'Your cart is empty',
  emptyCartCta: 'Start Shopping',
  subtotal: 'Subtotal',
  shipping: 'Shipping',
  shippingNote: 'Calculated at checkout',
  checkout: 'Checkout',
  continueShopping: 'Continue Shopping',
  remove: 'Remove',
};

const defaultLabelsAr = {
  title: 'سلة التسوق',
  emptyCart: 'سلة التسوق فارغة',
  emptyCartCta: 'ابدأ التسوق',
  subtotal: 'المجموع الفرعي',
  shipping: 'الشحن',
  shippingNote: 'يحسب عند الدفع',
  checkout: 'إتمام الشراء',
  continueShopping: 'متابعة التسوق',
  remove: 'حذف',
};

/**
 * Slide-out cart drawer component with item management.
 */
export const CartDrawer = forwardRef<HTMLDivElement, CartDrawerProps>(
  (
    {
      isOpen,
      onClose,
      items,
      onUpdateQuantity,
      onRemoveItem,
      onCheckout,
      currency = 'KWD',
      isRtl = false,
      labels: customLabels,
      continueShoppingHref = '/',
      isLoading = false,
    },
    ref
  ) => {
    const overlayRef = useRef<HTMLDivElement>(null);
    const drawerRef = useRef<HTMLDivElement>(null);

    const labels = {
      ...(isRtl ? defaultLabelsAr : defaultLabelsEn),
      ...customLabels,
    };

    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

    // Handle escape key
    useEffect(() => {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && isOpen) {
          onClose();
        }
      };

      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }, [isOpen, onClose]);

    // Handle body scroll lock
    useEffect(() => {
      if (isOpen) {
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
      return () => {
        document.body.style.overflow = '';
      };
    }, [isOpen]);

    // Focus trap
    useEffect(() => {
      if (isOpen && drawerRef.current) {
        const firstFocusable = drawerRef.current.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        firstFocusable?.focus();
      }
    }, [isOpen]);

    const handleOverlayClick = (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    };

    if (typeof window === 'undefined') return null;

    return createPortal(
      <div
        ref={overlayRef}
        onClick={handleOverlayClick}
        className={cn(
          'fixed inset-0 z-50 transition-opacity duration-300',
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        aria-hidden={!isOpen}
      >
        {/* Backdrop */}
        <div
          className={cn(
            'absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300',
            isOpen ? 'opacity-100' : 'opacity-0'
          )}
        />

        {/* Drawer */}
        <div
          ref={node => {
            (drawerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cart-drawer-title"
          dir={isRtl ? 'rtl' : 'ltr'}
          className={cn(
            'absolute top-0 h-full w-full max-w-md bg-background shadow-2xl transition-transform duration-300 ease-out',
            isRtl ? 'left-0' : 'right-0',
            isOpen ? 'translate-x-0' : isRtl ? '-translate-x-full' : 'translate-x-full'
          )}
        >
          <div className="flex h-full flex-col">
            {/* Header */}
            <header className="flex items-center justify-between border-b border-border px-4 py-4">
              <h2 id="cart-drawer-title" className="text-lg font-semibold text-foreground">
                {labels.title}
                {itemCount > 0 && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({itemCount})
                  </span>
                )}
              </h2>
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                aria-label={isRtl ? 'إغلاق' : 'Close cart'}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </header>

            {/* Cart Items */}
            <div className="flex-1 overflow-y-auto p-4">
              {items.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <svg
                    className="h-16 w-16 text-muted-foreground/50"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                    />
                  </svg>
                  <p className="mt-4 text-lg font-medium text-foreground">{labels.emptyCart}</p>
                  <a
                    href={continueShoppingHref}
                    className="mt-4 text-primary hover:underline"
                    onClick={onClose}
                  >
                    {labels.emptyCartCta}
                  </a>
                </div>
              ) : (
                <ul className="space-y-4">
                  {items.map(item => (
                    <li
                      key={item.id}
                      className="flex gap-4 rounded-lg border border-border bg-card p-3"
                    >
                      {/* Image */}
                      {item.image ? (
                        <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                          <img
                            src={item.image}
                            alt={isRtl && item.nameAr ? item.nameAr : item.name}
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-lg bg-muted">
                          <svg
                            className="h-8 w-8 text-muted-foreground"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1}
                              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                            />
                          </svg>
                        </div>
                      )}

                      {/* Details */}
                      <div className="flex flex-1 flex-col">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-medium text-foreground line-clamp-2">
                              {isRtl && item.nameAr ? item.nameAr : item.name}
                            </h3>
                            {item.variant && (
                              <p className="text-sm text-muted-foreground">
                                {isRtl && item.variantAr ? item.variantAr : item.variant}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => onRemoveItem(item.id)}
                            className="text-muted-foreground hover:text-red-500 transition-colors"
                            aria-label={`${labels.remove} ${item.name}`}
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>

                        <div className="mt-2 flex items-center justify-between">
                          <QuantitySelector
                            value={item.quantity}
                            onChange={qty => onUpdateQuantity(item.id, qty)}
                            min={1}
                            max={item.maxQuantity || 99}
                            size="sm"
                            isRtl={isRtl}
                          />
                          <Price
                            price={item.price * item.quantity}
                            currency={currency}
                            isRtl={isRtl}
                            size="sm"
                          />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Footer */}
            {items.length > 0 && (
              <footer className="border-t border-border p-4 space-y-4">
                {/* Subtotal */}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{labels.subtotal}</span>
                  <Price
                    price={subtotal}
                    currency={currency}
                    isRtl={isRtl}
                    size="lg"
                    showDiscount={false}
                  />
                </div>

                {/* Shipping Note */}
                <p className="text-sm text-muted-foreground text-center">{labels.shippingNote}</p>

                {/* Actions */}
                <div className="space-y-2">
                  <Button onClick={onCheckout} className="w-full" size="lg" disabled={isLoading}>
                    {isLoading ? (
                      <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                    ) : (
                      labels.checkout
                    )}
                  </Button>
                  <Button variant="outline" onClick={onClose} className="w-full">
                    {labels.continueShopping}
                  </Button>
                </div>
              </footer>
            )}
          </div>
        </div>
      </div>,
      document.body
    );
  }
);

CartDrawer.displayName = 'CartDrawer';
