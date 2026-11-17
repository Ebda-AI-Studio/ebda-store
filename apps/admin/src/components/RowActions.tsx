'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { cn } from '@ebda/ui';
import { useT } from '@/i18n/useT';

export interface RowActionItem {
  label: string;
  onSelect?: () => void;
  href?: string;
  /** Destructive items are always rendered last, in red, after a divider (rule 6). */
  destructive?: boolean;
  disabled?: boolean;
}

interface RowActionsProps {
  /** At most 1-2 inline icon/text buttons; the row itself opens the main action (edit). */
  primary?: ReactNode;
  items: RowActionItem[];
  /** Accessible name of the "..." trigger, e.g. "خيارات المنتج". Falls back to a generic label. */
  menuLabel?: string;
}

/** Normal items first (in the order given), destructive ones last. */
export function orderRowActionItems(items: RowActionItem[]): RowActionItem[] {
  return [...items.filter(i => !i.destructive), ...items.filter(i => i.destructive)];
}

/**
 * Row / header overflow menu ("..."): the action-placement standard's rule 6. Keyboard: Enter/Space/ArrowDown opens,
 * ArrowUp/Down moves, Escape closes and returns focus to the trigger. Touch targets are 44px.
 */
export function RowActions({ primary, items, menuLabel }: RowActionsProps) {
  const t = useT('components.rowActions');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu lives in a portal on <body>: inside a card grid every card is its own stacking context
  // (transform animations, overflow clip), so an in-flow absolute menu rendered UNDER the next card.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const menuId = useId();
  const ordered = orderRowActionItems(items);
  const firstDestructive = ordered.findIndex(i => i.destructive);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  // Place the menu against the trigger's inline-end edge, flipping above it when the viewport is short below.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) {
      setPos(null);
      return;
    }
    const r = triggerRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const rtl = getComputedStyle(triggerRef.current).direction === 'rtl';
    const left = rtl ? r.left : r.right - m.width;
    const top = r.bottom + 4 + m.height > window.innerHeight ? r.top - 4 - m.height : r.bottom + 4;
    setPos({
      top: Math.max(4, top),
      left: Math.min(Math.max(4, left), window.innerWidth - m.width - 4),
    });
  }, [open]);

  useEffect(() => {
    if (open && pos)
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open, pos]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
    );
    const idx = entries.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      entries[(idx + 1) % entries.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      entries[(idx - 1 + entries.length) % entries.length]?.focus();
    }
  };

  const itemClass = (destructive?: boolean) =>
    cn(
      'flex min-h-11 w-full items-center px-3 text-start text-sm transition-colors hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50',
      destructive ? 'text-destructive-ink' : 'text-foreground'
    );

  return (
    <div className="flex items-center gap-1">
      {primary}
      {ordered.length > 0 && (
        <div className="relative" ref={rootRef}>
          <Button
            variant="outline"
            size="icon"
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={menuLabel ?? t('more')}
            onClick={() => setOpen(o => !o)}
            className="justify-center text-muted-foreground"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </Button>
          {open &&
            createPortal(
              <div
                id={menuId}
                ref={menuRef}
                role="menu"
                onKeyDown={onMenuKey}
                style={{
                  position: 'fixed',
                  top: pos?.top ?? 0,
                  left: pos?.left ?? 0,
                  visibility: pos ? 'visible' : 'hidden',
                }}
                className="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
              >
                {ordered.map((item, i) => {
                  const close = () => {
                    setOpen(false);
                    item.onSelect?.();
                  };
                  return (
                    <div key={`${item.label}-${i}`}>
                      {i === firstDestructive && i > 0 && (
                        <div role="separator" className="my-1 h-px bg-border" />
                      )}
                      {item.href && !item.disabled ? (
                        <Link
                          href={item.href}
                          role="menuitem"
                          className={itemClass(item.destructive)}
                          onClick={() => setOpen(false)}
                        >
                          {item.label}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={item.disabled}
                          className={itemClass(item.destructive)}
                          onClick={close}
                        >
                          {item.label}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>,
              document.body
            )}
        </div>
      )}
    </div>
  );
}
