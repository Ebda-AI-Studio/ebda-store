'use client';

/**
 * The accessible disclosure that replaces native <details> in the editor (plan F7): a real button with
 * `aria-expanded` / `aria-controls`, a chevron that rotates (no left/right so it needs no RTL flip), a 150ms ease-out
 * height change, off under `prefers-reduced-motion`. Controlled (`open` + `onOpenChange`) or uncontrolled.
 */
import { useId, useState, type ReactNode } from 'react';
import { Chevron } from './Field';
import { cn } from '@ebda/ui/cn';

export function Disclosure({
  title,
  badge,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  /** Small marker shown after the title (e.g. "edited" dot). */
  badge?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const id = useId();
  const [inner, setInner] = useState(defaultOpen);
  const isOpen = open ?? inner;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInner(next);
    onOpenChange?.(next);
  };
  return (
    <div
      className={cn('rounded-lg border border-border bg-card', className)}
      data-testid={testId}
      data-state={isOpen ? 'open' : 'closed'}
    >
      <button
        data-ui="row"
        type="button"
        id={`${id}-trigger`}
        aria-expanded={isOpen}
        aria-controls={`${id}-panel`}
        onClick={toggle}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-start text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span>{title}</span>
          {badge}
        </span>
        <Chevron
          aria-hidden="true"
          className={cn(
            'h-4 w-4 shrink-0 text-muted-ink transition-transform duration-150 motion-reduce:transition-none',
            isOpen && 'rotate-180'
          )}
        />
      </button>
      <div
        id={`${id}-panel`}
        role="region"
        aria-labelledby={`${id}-trigger`}
        hidden={!isOpen}
        className="border-t border-border p-3"
      >
        {children}
      </div>
    </div>
  );
}
