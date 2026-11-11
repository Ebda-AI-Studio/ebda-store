'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
  const menuId = useId();
  const ordered = orderRowActionItems(items);
  const firstDestructive = ordered.findIndex(i => i.destructive);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open)
      rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const entries = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
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
          {open && (
            <div
              id={menuId}
              role="menu"
              className="absolute end-0 top-full z-30 mt-1 min-w-48 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md"
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
