'use client';

/**
 * Side drawer used by the Dahab header (menu from the inline START, bag from
 * the inline END — both mirror in Arabic). The Dahab skin of the one shared
 * `Sheet` primitive (R-04): Escape and the backdrop close it, focus moves in on
 * open, stays inside, and returns to the trigger on close, the page behind is
 * inert and does not scroll. Slide-in is transform-only and off under reduced
 * motion.
 */
import type { ReactNode } from 'react';
import { Sheet } from '../../components/ui/Sheet';

export function DahabDrawer({
  open,
  onClose,
  side,
  label,
  closeLabel,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  side: 'start' | 'end';
  label: string;
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      side={side}
      title={label}
      closeLabel={closeLabel}
      footer={footer}
      className={`border-border bg-background text-foreground shadow-[0_0_60px_-10px_hsl(var(--background))] ${
        side === 'start' ? 'border-e' : 'border-s'
      }`}
      backdropClassName="backdrop:bg-foreground/40"
      headerClassName="h-16 border-b border-border !pe-5 !pt-0"
      titleClassName="font-display text-xl text-foreground"
      closeClassName="-me-2 text-foreground/80 hover:text-primary"
      bodyClassName=""
      footerClassName="border-t border-border p-5"
    >
      {children}
    </Sheet>
  );
}
