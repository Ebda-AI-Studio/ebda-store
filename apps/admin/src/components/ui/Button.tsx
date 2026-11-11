/**
 * The merchant admin's ONE button system (ruling docs/rulings/2026-11-10-admin-button-system.md).
 *
 * Every clickable that looks like a button in apps/admin renders through `Button` or takes its
 * classes from `buttonVariants()` (for a <Link>, a <label> or a native <button> that needs a ref
 * pattern the component cannot carry). tests/unit/admin-button-system.test.ts fails on a raw
 * `<button>` that styles its own height / padding / radius.
 *
 * Scale (heights mirror @ebda/ui Input: 44px on phones, 40px from `sm:` up):
 *   sm  32px  13px  dense rows, chips, pagination, segmented filters (44px hit area on phones)
 *   md  40px  14px  the default; 44px under 640px
 *   lg  44px  16px  a page's main action, sticky footers, full-width rows
 *   icon-sm 32 · icon 40 (44 on phones) · icon-lg 44 — square icon-only buttons
 * One radius: rounded-md (calc(var(--radius) - 2px) = 12px), the same token inputs use.
 *
 * Like @ebda/ui's Button, `type` is NOT defaulted: a <Button> inside a <form> without a type submits it,
 * so swapping the import never changes behaviour.
 *
 * Variants: default (filled gold, the one primary per view) · outline (secondary action) ·
 * secondary (tinted fill) · ghost (quiet) · soft (the selected tab / segment / chip) ·
 * destructive · link (text only, keeps the size's height so it stays a real tap target).
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';
// Subpath, not the barrel: admin tests vi.mock('@ebda/ui') wholesale and would drop `cn`.
import { cn } from '@ebda/ui/cn';

export type ButtonVariant =
  | 'default'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'soft'
  | 'destructive'
  | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon-sm' | 'icon' | 'icon-lg';

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:shrink-0';

/** Phones only: grow a 32px control's hit area to 44px without changing how it looks. */
const PHONE_HIT_AREA =
  "relative before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] sm:before:hidden";

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  outline:
    'border border-input bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
  soft: 'bg-primary/15 text-primary-ink hover:bg-primary/20',
  destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
  link: 'px-0 text-primary-ink underline-offset-4 hover:underline',
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: `h-8 px-3 text-[13px] ${PHONE_HIT_AREA}`,
  md: 'h-11 px-4 text-sm sm:h-10',
  lg: 'h-11 px-5 text-base',
  'icon-sm': `h-8 w-8 text-sm ${PHONE_HIT_AREA}`,
  icon: 'h-11 w-11 text-sm sm:h-10 sm:w-10',
  'icon-lg': 'h-11 w-11 text-sm',
};

export function buttonVariants({
  variant = 'default',
  size = 'md',
  className,
}: { variant?: ButtonVariant | null; size?: ButtonSize | null; className?: string } = {}): string {
  return cn(BASE, BUTTON_SIZES[size ?? 'md'], BUTTON_VARIANTS[variant ?? 'default'], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, isLoading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={buttonVariants({ variant, size, className })}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {/* aria-busy announces the wait; the spinner is decoration. */}
      {isLoading ? (
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </button>
  )
);

Button.displayName = 'Button';
