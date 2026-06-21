'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Standard buttonVariants (shadcn-compatible)
// ---------------------------------------------------------------------------

export const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        cool: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-border bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        xl: 'h-14 rounded-lg px-10 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

// ---------------------------------------------------------------------------
// LiquidButton — glass / frosted-glass effect
// ---------------------------------------------------------------------------

export const liquidbuttonVariants = cva(
  'relative inline-flex cursor-pointer select-none items-center justify-center rounded-2xl border border-white/20 font-semibold text-white transition-all duration-200 active:scale-95',
  {
    variants: {
      size: {
        sm: 'px-4 py-2 text-sm',
        default: 'px-6 py-3 text-base',
        lg: 'px-8 py-3.5 text-lg',
        xl: 'px-10 py-4 text-xl',
      },
    },
    defaultVariants: { size: 'default' },
  }
);

export interface LiquidButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof liquidbuttonVariants> {}

/** SVG filter that produces the liquid/glass distortion effect. */
function GlassFilter() {
  return (
    <svg aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        <filter id="container-glass">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.65 0.75"
            numOctaves="3"
            seed="2"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="8"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}

/** Subtle top-edge shine overlay. */
function ShineEffect() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-2xl"
      style={{
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.05) 50%, transparent 100%)',
      }}
    />
  );
}

/** Shared glass styling for the liquid button + its anchor-link twin below. */
export const LIQUID_GLASS_STYLE: React.CSSProperties = {
  backdropFilter: 'blur(12px) url("#container-glass")',
  WebkitBackdropFilter: 'blur(12px) url("#container-glass")',
  background: 'rgba(255,255,255,0.10)',
  boxShadow: '0 4px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.25)',
};

export const LiquidButton = React.forwardRef<HTMLButtonElement, LiquidButtonProps>(
  ({ className, size, children, style, ...props }, ref) => {
    return (
      <>
        <GlassFilter />
        <button
          ref={ref}
          className={cn(liquidbuttonVariants({ size, className }))}
          style={{ ...LIQUID_GLASS_STYLE, ...style }}
          {...props}
        >
          <ShineEffect />
          <span className="relative z-10">{children}</span>
        </button>
      </>
    );
  }
);
LiquidButton.displayName = 'LiquidButton';

/**
 * Anchor twin of LiquidButton — identical liquid-glass look, but a real `<a>`
 * so it can be a navigation/CTA link (WhatsApp, email, scroll anchors). Using a
 * styled anchor avoids the `asChild`/Slot decoration-merge complexity.
 */
export interface LiquidLinkProps
  extends
    React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof liquidbuttonVariants> {}

export const LiquidLink = React.forwardRef<HTMLAnchorElement, LiquidLinkProps>(
  ({ className, size, children, style, ...props }, ref) => {
    return (
      <>
        <GlassFilter />
        <a
          ref={ref}
          className={cn(liquidbuttonVariants({ size, className }))}
          style={{ ...LIQUID_GLASS_STYLE, ...style }}
          {...props}
        >
          <ShineEffect />
          <span className="relative z-10">{children}</span>
        </a>
      </>
    );
  }
);
LiquidLink.displayName = 'LiquidLink';
