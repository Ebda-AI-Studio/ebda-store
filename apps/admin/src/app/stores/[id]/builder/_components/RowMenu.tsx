'use client';

/**
 * Compact overflow menu for a tree row. The panel is `position: fixed` (placed from the trigger's
 * rect) so the scrolling left pane never clips it, and it flips upward near the bottom edge.
 * Keyboard: Enter/Space/ArrowDown opens, ArrowUp/Down move, Escape closes and returns focus.
 */
import { Button } from '@/components/ui/Button';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface RowMenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

const MENU_HEIGHT_GUESS = 190;

export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; insetInlineEnd: number }>({
    insetInlineEnd: 0,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const rtl = document.documentElement.dir === 'rtl';
      const inline = Math.max(8, rtl ? r.left : window.innerWidth - r.right);
      const below = window.innerHeight - r.bottom > MENU_HEIGHT_GUESS;
      setPos(
        below
          ? { top: r.bottom + 4, insetInlineEnd: inline }
          : { bottom: window.innerHeight - r.top + 4, insetInlineEnd: inline }
      );
    }
    setOpen(o => !o);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const entries = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
    );
    const idx = entries.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      entries[(idx + 1) % entries.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      entries[(idx - 1 + entries.length) % entries.length]?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };

  const firstDestructive = items.findIndex(i => i.destructive);

  return (
    <div ref={rootRef} onKeyDown={open ? onKey : undefined} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon-sm"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={toggle}
        className="text-muted-foreground"
        data-ui="row-menu"
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          style={{ position: 'fixed', ...pos }}
          className="editor-motion-pop z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
        >
          {items.map((item, i) => (
            <div key={item.label}>
              {i === firstDestructive && i > 0 && (
                <div role="separator" className="my-1 h-px bg-border" />
              )}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex min-h-8 w-full items-center gap-2 px-3 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50 ${
                  item.destructive ? 'text-destructive-ink' : 'text-foreground'
                }`}
              >
                <span className="shrink-0" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
