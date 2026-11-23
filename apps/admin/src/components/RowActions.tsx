'use client';

import { Button } from '@/components/ui/Button';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
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

const MENU_GUTTER = 8;

interface RowMenuPlacementInput {
  trigger: { top: number; bottom: number; left: number; right: number };
  menuWidth: number;
  menuHeight: number;
  viewport: { width: number; height: number };
  inset?: { top: number; right: number; bottom: number; left: number };
  rtl: boolean;
}

/**
 * Fixed-position coordinates for the row menu. The menu's END edge aligns with the trigger's end edge (right in LTR,
 * left in RTL); it flips above the trigger when it does not fit below; both axes are then clamped into the viewport
 * (8px gutter + safe-area inset), so a trigger near either edge can never push the menu off-screen.
 */
// pq-allow(unused-export): test seam, imported by apps/admin/src/components/RowActions.portal.test.tsx
export function placeRowMenu(i: RowMenuPlacementInput): {
  top: number;
  left: number;
  maxWidth: number;
} {
  const inset = i.inset ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const minX = MENU_GUTTER + inset.left;
  const maxX = i.viewport.width - MENU_GUTTER - inset.right;
  const minY = MENU_GUTTER + inset.top;
  const maxY = i.viewport.height - MENU_GUTTER - inset.bottom;
  const maxWidth = Math.max(0, maxX - minX);
  const w = Math.min(i.menuWidth, maxWidth);
  const h = i.menuHeight;
  const wantLeft = i.rtl ? i.trigger.left : i.trigger.right - w;
  const left = Math.max(minX, Math.min(wantLeft, maxX - w));
  const below = i.trigger.bottom + 4;
  const above = i.trigger.top - 4 - h;
  const top0 = below + h > maxY && above >= minY ? above : below;
  const top = Math.max(minY, Math.min(top0, maxY - h));
  return { top, left, maxWidth };
}

/** Safe-area insets (iOS notch / home indicator) in px; zeros where env() is unsupported. */
function readSafeAreaInsets() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const n = (v: string) => Number.parseFloat(v) || 0;
  const out = {
    top: n(cs.paddingTop),
    right: n(cs.paddingRight),
    bottom: n(cs.paddingBottom),
    left: n(cs.paddingLeft),
  };
  probe.remove();
  return out;
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
  const [pos, setPos] = useState<CSSProperties | null>(null);
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
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  // QA-86: the menu lives in a portal with fixed coordinates, so a table card's overflow can never clip it. Placement
  // is a pure function (placeRowMenu): end-aligned to the trigger, flipped above when there is no room below, then
  // clamped so the whole menu stays inside the viewport minus an 8px gutter and the iOS safe areas.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const rtl = getComputedStyle(triggerRef.current).direction === 'rtl';
    const vv = window.visualViewport;
    setPos(
      placeRowMenu({
        trigger: r,
        menuWidth: menuRef.current?.offsetWidth ?? 0,
        menuHeight: menuRef.current?.offsetHeight ?? 0,
        viewport: {
          width: vv?.width ?? window.innerWidth,
          height: vv?.height ?? window.innerHeight,
        },
        inset: readSafeAreaInsets(),
        rtl,
      })
    );
  }, [open, ordered.length]);

  useEffect(() => {
    if (open)
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
        <div className="relative" ref={rootRef} onKeyDown={open ? onMenuKey : undefined}>
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
                style={{ position: 'fixed', ...(pos ?? { top: 0, left: 0, visibility: 'hidden' }) }}
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
