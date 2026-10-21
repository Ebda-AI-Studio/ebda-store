/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}', '../../packages/ui/src/**/*.{js,ts,jsx,tsx}'],
  // `text-gray-700` was emitted into this bundle only because @ebda/ui's Label
  // used it (issue 2380 moved Label to `text-foreground`). Nothing in apps/web
  // renders Label, but merchant-authored HTML could carry the class, so it is
  // kept: the storefront stylesheet may only GROW from a shared-package change,
  // never lose a rule (demo-store must not change; Ruling YWA-TXT-1).
  safelist: ['text-gray-700'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          // Issue 2349 (owner option A, 2026-09-30) — readable message text. The
          // value is per store (`statusInkVars`, emitted with the theme); a store
          // with `theme.legacyBannerContrast` gets `var(--destructive)`, i.e. the
          // SAME colour as DEFAULT, so its @ebda/ui form errors (`text-destructive-ink`,
          // issue 2380) and message text stay pixel-identical.
          ink: 'hsl(var(--destructive-ink))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
          // Issue 2349 — readable message text; per-store value from the theme.
          ink: 'hsl(var(--success-ink))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          // Issue 2349 — readable message text; per-store value from the theme.
          ink: 'hsl(var(--warning-ink))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
          // Issue 2349 — readable message text; per-store value from the theme.
          ink: 'hsl(var(--info-ink))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'toast-slide-in': {
          from: { transform: 'translateX(100%)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        'toast-progress': {
          from: { width: '100%' },
          to: { width: '0%' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.5s infinite',
        'toast-in': 'toast-slide-in 0.3s ease-out',
      },
    },
  },
  plugins: [],
};
