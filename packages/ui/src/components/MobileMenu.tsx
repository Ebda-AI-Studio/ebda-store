'use client';

import { forwardRef, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../utils/cn';

export interface MobileMenuItem {
  id: string;
  label: string;
  labelAr?: string;
  href?: string;
  icon?: React.ReactNode;
  children?: MobileMenuItem[];
  badge?: string;
  badgeAr?: string;
}

export interface MobileMenuProps {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Callback to close the menu */
  onClose: () => void;
  /** Menu items */
  items: MobileMenuItem[];
  /** Show in RTL format */
  isRtl?: boolean;
  /** Store logo */
  logo?: React.ReactNode;
  /** Store name */
  storeName?: string;
  /** Position of the menu */
  position?: 'left' | 'right';
  /** Header actions (cart, wishlist, account icons) */
  headerActions?: React.ReactNode;
  /** Footer content (social links, etc.) */
  footerContent?: React.ReactNode;
  /** Custom labels */
  labels?: Partial<{
    close: string;
    back: string;
    menu: string;
  }>;
  /** Link component for Next.js Link or custom routing */
  LinkComponent?: React.ComponentType<{
    href: string;
    className?: string;
    onClick?: () => void;
    children: React.ReactNode;
  }>;
}

const defaultLabels = {
  en: {
    close: 'Close menu',
    back: 'Back',
    menu: 'Menu',
  },
  ar: {
    close: 'إغلاق القائمة',
    back: 'رجوع',
    menu: 'القائمة',
  },
};

/**
 * Mobile navigation menu with slide-out drawer and nested navigation.
 */
export const MobileMenu = forwardRef<HTMLDivElement, MobileMenuProps>(
  (
    {
      isOpen,
      onClose,
      items,
      isRtl = false,
      logo,
      storeName,
      position = 'left',
      headerActions,
      footerContent,
      labels: customLabels,
      LinkComponent,
    },
    ref
  ) => {
    const [submenuStack, setSubmenuStack] = useState<MobileMenuItem[]>([]);
    const menuRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);

    const labels = {
      ...defaultLabels[isRtl ? 'ar' : 'en'],
      ...customLabels,
    };

    // Default anchor link if no custom component provided
    const Link =
      LinkComponent ||
      (({
        href,
        className,
        onClick,
        children,
      }: {
        href: string;
        className?: string;
        onClick?: () => void;
        children: React.ReactNode;
      }) => (
        <a href={href} className={className} onClick={onClick}>
          {children}
        </a>
      ));

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

    // Handle body scroll lock and reset submenu state when menu closes
    useEffect(() => {
      const handleMenuState = () => {
        if (isOpen) {
          document.body.style.overflow = 'hidden';
        } else {
          document.body.style.overflow = '';
          // Reset submenu state when closed
          setSubmenuStack([]);
        }
      };
      handleMenuState();
      return () => {
        document.body.style.overflow = '';
      };
    }, [isOpen]);

    // Focus trap
    useEffect(() => {
      if (isOpen && menuRef.current) {
        const firstFocusable = menuRef.current.querySelector<HTMLElement>(
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

    const handleSubmenuOpen = (item: MobileMenuItem) => {
      setSubmenuStack(prev => [...prev, item]);
    };

    const handleBack = () => {
      setSubmenuStack(prev => prev.slice(0, -1));
    };

    const handleItemClick = () => {
      onClose();
    };

    // Get current menu items to display
    const getCurrentItems = (): MobileMenuItem[] => {
      if (submenuStack.length === 0) {
        return items;
      }
      const currentParent = submenuStack[submenuStack.length - 1];
      return currentParent.children || [];
    };

    const currentItems = getCurrentItems();
    const currentTitle =
      submenuStack.length > 0
        ? isRtl && submenuStack[submenuStack.length - 1].labelAr
          ? submenuStack[submenuStack.length - 1].labelAr
          : submenuStack[submenuStack.length - 1].label
        : labels.menu;

    if (typeof window === 'undefined') return null;

    // Adjust position for RTL
    const menuPosition = isRtl ? (position === 'left' ? 'right' : 'left') : position;

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

        {/* Menu Panel */}
        <div
          ref={node => {
            (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          role="dialog"
          aria-modal="true"
          aria-label={labels.menu}
          dir={isRtl ? 'rtl' : 'ltr'}
          className={cn(
            'absolute top-0 h-full w-full max-w-xs bg-background shadow-2xl transition-transform duration-300 ease-out',
            menuPosition === 'left' ? 'left-0' : 'right-0',
            isOpen
              ? 'translate-x-0'
              : menuPosition === 'left'
                ? '-translate-x-full'
                : 'translate-x-full'
          )}
        >
          <div className="flex h-full flex-col">
            {/* Header */}
            <header className="flex items-center justify-between border-b border-border px-4 py-4">
              <div className="flex items-center gap-3">
                {submenuStack.length > 0 ? (
                  <button
                    onClick={handleBack}
                    className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={labels.back}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d={isRtl ? 'M9 5l7 7-7 7' : 'M15 19l-7-7 7-7'}
                      />
                    </svg>
                    <span>{labels.back}</span>
                  </button>
                ) : logo ? (
                  <div className="flex-shrink-0">{logo}</div>
                ) : storeName ? (
                  <span className="font-semibold text-lg">{storeName}</span>
                ) : null}
              </div>

              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                aria-label={labels.close}
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

            {/* Submenu Title */}
            {submenuStack.length > 0 && (
              <div className="px-4 py-3 bg-muted/50 border-b border-border">
                <h2 className="font-semibold text-foreground">{currentTitle}</h2>
              </div>
            )}

            {/* Header Actions */}
            {headerActions && submenuStack.length === 0 && (
              <div className="flex items-center justify-center gap-4 px-4 py-3 border-b border-border">
                {headerActions}
              </div>
            )}

            {/* Menu Items */}
            <nav className="flex-1 overflow-y-auto py-2">
              <ul className="space-y-1 px-2">
                {currentItems.map(item => {
                  const hasChildren = item.children && item.children.length > 0;
                  const label = isRtl && item.labelAr ? item.labelAr : item.label;
                  const badge = isRtl && item.badgeAr ? item.badgeAr : item.badge;

                  return (
                    <li key={item.id}>
                      {hasChildren ? (
                        <button
                          onClick={() => handleSubmenuOpen(item)}
                          className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-lg text-foreground hover:bg-muted transition-colors"
                        >
                          <span className="flex items-center gap-3">
                            {item.icon && (
                              <span className="flex-shrink-0 text-muted-foreground">
                                {item.icon}
                              </span>
                            )}
                            <span className="font-medium">{label}</span>
                            {badge && (
                              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-primary text-primary-foreground">
                                {badge}
                              </span>
                            )}
                          </span>
                          <svg
                            className="w-5 h-5 text-muted-foreground"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d={isRtl ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
                            />
                          </svg>
                        </button>
                      ) : item.href ? (
                        <Link
                          href={item.href}
                          onClick={handleItemClick}
                          className="flex items-center gap-3 px-4 py-3 rounded-lg text-foreground hover:bg-muted transition-colors"
                        >
                          {item.icon && (
                            <span className="flex-shrink-0 text-muted-foreground">{item.icon}</span>
                          )}
                          <span className="font-medium">{label}</span>
                          {badge && (
                            <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-primary text-primary-foreground">
                              {badge}
                            </span>
                          )}
                        </Link>
                      ) : (
                        <span className="flex items-center gap-3 px-4 py-3 rounded-lg text-muted-foreground">
                          {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
                          <span className="font-medium">{label}</span>
                          {badge && (
                            <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-primary text-primary-foreground">
                              {badge}
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </nav>

            {/* Footer */}
            {footerContent && submenuStack.length === 0 && (
              <footer className="border-t border-border px-4 py-4">{footerContent}</footer>
            )}
          </div>
        </div>
      </div>,
      document.body
    );
  }
);

MobileMenu.displayName = 'MobileMenu';

/**
 * Hamburger button to toggle the mobile menu.
 */
export interface MobileMenuButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show in RTL format */
  isRtl?: boolean;
}

const buttonSizeStyles = {
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-12 h-12',
};

const iconSizeStyles = {
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
};

export const MobileMenuButton = forwardRef<HTMLButtonElement, MobileMenuButtonProps>(
  ({ isOpen, size = 'md', isRtl = false, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          'inline-flex items-center justify-center rounded-lg',
          'text-foreground hover:bg-muted transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
          buttonSizeStyles[size],
          className
        )}
        aria-label={
          isOpen ? (isRtl ? 'إغلاق القائمة' : 'Close menu') : isRtl ? 'فتح القائمة' : 'Open menu'
        }
        aria-expanded={isOpen}
        {...props}
      >
        <svg
          className={cn('transition-transform duration-200', iconSizeStyles[size])}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          {isOpen ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          )}
        </svg>
      </button>
    );
  }
);

MobileMenuButton.displayName = 'MobileMenuButton';
