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
        cool: 'bg-blue-600 text-white hover:bg-blue-700',
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

export const LiquidButton = React.forwardRef<HTMLButtonElement, LiquidButtonProps>(
  ({ className, size, children, style, ...props }, ref) => {
    return (
      <>
        <GlassFilter />
        <button
          ref={ref}
          className={cn(liquidbuttonVariants({ size, className }))}
          style={{
            backdropFilter: 'blur(12px) url("#container-glass")',
            WebkitBackdropFilter: 'blur(12px) url("#container-glass")',
            background: 'rgba(255,255,255,0.10)',
            boxShadow: '0 4px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.25)',
            ...style,
          }}
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

// ---------------------------------------------------------------------------
// MetalButton — gradient metallic feel with press/hover state
// ---------------------------------------------------------------------------

type ColorVariant = 'default' | 'primary' | 'success' | 'error' | 'gold' | 'bronze';

interface ColorConfig {
  outer: string;
  inner: string;
  button: string;
}

const colorVariants: Record<ColorVariant, ColorConfig> = {
  default: {
    outer: 'from-zinc-400 via-zinc-300 to-zinc-500',
    inner: 'from-zinc-600 to-zinc-800',
    button: 'from-zinc-200 via-zinc-100 to-zinc-300 text-zinc-900',
  },
  primary: {
    // Force brand orange
    outer: 'from-primary via-secondary to-muted',
    inner: 'from-primary to-primary/40',
    button: 'from-primary/90 via-primary to-primary/70 text-white',
  },
  success: {
    outer: 'from-green-400 via-green-300 to-green-600',
    inner: 'from-green-600 to-green-800',
    button: 'from-green-300 via-green-200 to-green-400 text-green-900',
  },
  error: {
    outer: 'from-red-400 via-red-300 to-red-600',
    inner: 'from-red-600 to-red-800',
    button: 'from-red-300 via-red-200 to-red-400 text-red-900',
  },
  gold: {
    outer: 'from-yellow-400 via-yellow-200 to-yellow-500',
    inner: 'from-yellow-600 to-yellow-800',
    button: 'from-yellow-200 via-yellow-100 to-yellow-300 text-yellow-900',
  },
  bronze: {
    outer: 'from-amber-600 via-amber-400 to-amber-700',
    inner: 'from-amber-800 to-amber-950',
    button: 'from-amber-400 via-amber-300 to-amber-500 text-amber-950',
  },
};

export interface MetalButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  colorVariant?: ColorVariant;
  size?: 'sm' | 'default' | 'lg' | 'xl';
}

export const MetalButton = React.forwardRef<HTMLButtonElement, MetalButtonProps>(
  (
    {
      className,
      colorVariant = 'default',
      size = 'default',
      children,
      onMouseEnter,
      onMouseLeave,
      onMouseDown,
      onMouseUp,
      onTouchStart,
      onTouchEnd,
      ...props
    },
    ref
  ) => {
    const [pressed, setPressed] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [isTouch, setIsTouch] = React.useState(false);

    // Detect touch device on mount
    React.useEffect(() => {
      setIsTouch(
        typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
      );
    }, []);

    const colors = colorVariants[colorVariant];

    const sizePadding: Record<string, string> = {
      sm: 'px-4 py-1.5 text-sm',
      default: 'px-6 py-2.5 text-base',
      lg: 'px-8 py-3 text-lg',
      xl: 'px-10 py-4 text-xl',
    };

    return (
      <button
        ref={ref}
        className={cn(
          // Outer metallic ring
          'relative inline-flex rounded-xl bg-gradient-to-b p-[2px] transition-transform duration-100',
          colors.outer,
          pressed ? 'scale-95' : hovered ? 'scale-105' : 'scale-100',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:opacity-50',
          className
        )}
        onMouseEnter={e => {
          if (!isTouch) setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={e => {
          if (!isTouch) setHovered(false);
          onMouseLeave?.(e);
        }}
        onMouseDown={e => {
          setPressed(true);
          onMouseDown?.(e);
        }}
        onMouseUp={e => {
          setPressed(false);
          onMouseUp?.(e);
        }}
        onTouchStart={e => {
          setPressed(true);
          onTouchStart?.(e);
        }}
        onTouchEnd={e => {
          setPressed(false);
          onTouchEnd?.(e);
        }}
        {...props}
      >
        {/* Inner recess ring */}
        <span
          className={cn(
            'relative flex w-full items-center justify-center rounded-[10px] bg-gradient-to-b p-[2px]',
            colors.inner
          )}
        >
          {/* Button face */}
          <span
            className={cn(
              'relative flex w-full items-center justify-center rounded-lg bg-gradient-to-b font-semibold shadow-inner',
              colors.button,
              sizePadding[size] ?? sizePadding['default']
            )}
          >
            {/* Shine */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-lg"
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.40) 0%, transparent 60%)',
              }}
            />
            <span className="relative z-10">{children}</span>
          </span>
        </span>
      </button>
    );
  }
);
MetalButton.displayName = 'MetalButton';
