'use client';

/**
 * Dahab (دهب) design primitives — the jewellery skin under the Worn, Workshop and Gift box looks
 * (Phase B5; docs/ebda/templates/dahab.md).
 *
 * Every colour comes from the store theme tokens (`--primary`, `--accent`, `--background`,
 * `--foreground`), which the active look sets, so a merchant who re-colours the theme re-colours
 * Dahab. The display face is the look's `--font-display` (looks/fonts.ts).
 *
 * Arabic-first rules held here: logical properties only (`ps`/`pe`/`start`/
 * `end`), direction-aware chevrons (`rtl:-scale-x-100`), no letter-spacing on
 * Arabic (globals.css resets it under `:lang(ar)`), Western digits by default
 * (prices go through `useLocalePrice`).
 */
import type { ReactNode, SVGProps } from 'react';
import Link from 'next/link';
import { useLanguage } from '../../contexts/LanguageContext';
import { settingMarker, useEditorMode } from '../../builder/render/editor-mode';

/** Primary action: the look's primary fill with its on-primary ink. */
export const DAHAB_BTN_PRIMARY =
  'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[var(--radius)] bg-primary px-7 text-sm font-medium text-primary-foreground transition-[background-color,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-accent active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';

/** Secondary action: a primary hairline on the page. */
export const DAHAB_BTN_SECONDARY =
  'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-[var(--radius)] border border-primary/70 px-7 text-sm font-medium text-primary transition-colors duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** Quiet text link with a primary underline that draws in on hover. */
export const DAHAB_LINK =
  'relative inline-flex min-h-[44px] items-center text-sm text-primary after:absolute after:inset-x-0 after:bottom-2.5 after:h-px after:origin-left rtl:after:origin-right after:scale-x-0 after:bg-current after:transition-transform after:duration-300 hover:after:scale-x-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm';

export const DAHAB_CONTAINER = 'mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8';

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

/** Pick the visitor's language from an en/ar pair, falling back to the other. */
export function pick(isRtl: boolean, en?: string | null, ar?: string | null): string {
  return ((isRtl ? ar || en : en || ar) ?? '').trim();
}

/**
 * Section heading: display face, start-aligned, with an optional "view all"
 * link sharing its baseline and a bronze hairline under the pair. The
 * hairline is the one structural device Dahab repeats; it separates a
 * heading from its goods the way a jeweller's tray lip does.
 */
export function DahabSectionHeading({
  title,
  subtitle,
  actionLabel,
  actionHref,
  align = 'start',
  id,
}: {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  actionHref?: string;
  align?: 'start' | 'center';
  id?: string;
}) {
  // Canvas only: the title is the section's `title` setting (see SectionHeading).
  const editorMode = useEditorMode();
  const { isRtl } = useLanguage();
  if (!title && !subtitle) return null;
  const centered = align === 'center';
  return (
    <div className={cx('mb-8 sm:mb-10', centered && 'text-center')}>
      <div
        className={cx(
          'flex flex-wrap items-end gap-x-6 gap-y-2',
          centered ? 'justify-center' : 'justify-between'
        )}
      >
        <div className={cx('min-w-0', centered && 'mx-auto')}>
          {title && (
            <h2
              id={id}
              className="font-display text-balance text-[clamp(1.6rem,1.15rem+1.5vw,2.4rem)] leading-[1.15] text-foreground rtl:leading-[1.45]"
              {...settingMarker(editorMode, 'title', isRtl)}
            >
              {title}
            </h2>
          )}
          {subtitle && (
            <p className="mt-2 max-w-[56ch] text-pretty text-[15px] leading-relaxed text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {actionLabel && actionHref && !centered && (
          <Link href={actionHref} className={DAHAB_LINK}>
            {actionLabel}
            <ChevronIcon className="ms-1 h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <div
        aria-hidden="true"
        className={cx(
          'mt-5 h-px bg-gradient-to-r from-primary/50 via-border to-transparent rtl:bg-gradient-to-l',
          centered && 'mx-auto max-w-[180px] from-transparent via-primary/60 to-transparent'
        )}
      />
    </div>
  );
}

// ── Icons: 1.25px strokes, drawn for this skin ────────────────────────────
type IconProps = SVGProps<SVGSVGElement>;
const base = (p: IconProps) => ({
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.25,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
  'aria-hidden': true,
  ...p,
});

export const SearchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </svg>
);
export const BagIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 8h14l-1.2 12.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8L5 8Z" />
    <path d="M9 10V7a3 3 0 0 1 6 0v3" />
  </svg>
);
export const UserIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M4.5 20c1.4-3.6 4.2-5.2 7.5-5.2s6.1 1.6 7.5 5.2" />
  </svg>
);
export const MenuIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);
export const CloseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
/** Points to the inline END; mirrors itself in Arabic. */
export const ChevronIcon = ({ className, ...p }: IconProps) => (
  <svg {...base(p)} className={cx(className, 'rtl:-scale-x-100')}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
export const PlusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const MinusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
);
export const HeartIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <svg {...base(p)} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />
  </svg>
);
export const ZoomIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5M10.5 8v5M8 10.5h5" />
  </svg>
);

/** Trust-badge glyphs (keys = TRUST_BADGE_ICONS in @ebda/shared). */
export const BADGE_GLYPHS: Record<string, ReactNode> = {
  cod: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="1.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6.5 9.5v5M17.5 9.5v5" />
    </>
  ),
  instapay: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2" />
      <path d="M10.5 18.5h3M9.5 9.5l2 2 3.5-4" />
    </>
  ),
  shipping: (
    <>
      <path d="M2.5 7.5h11v9h-11zM13.5 10.5h4l3 3v3h-7" />
      <circle cx="6.5" cy="17.5" r="1.6" />
      <circle cx="17" cy="17.5" r="1.6" />
    </>
  ),
  certified: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.4 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5.1 7.5-9.5V6L12 3Z" />
      <path d="m8.8 12 2.2 2.2 4.2-4.4" />
    </>
  ),
  returns: (
    <>
      <path d="M4 9h11a5 5 0 0 1 0 10H8" />
      <path d="m7.5 5.5-3.5 3.5 3.5 3.5" />
    </>
  ),
  gift: (
    <>
      <rect x="3.5" y="9" width="17" height="11" rx="1" />
      <path d="M2.5 9h19v-3h-19zM12 6v14M12 6c-1.5-3-5-3.5-5-1s5 1 5 1Zm0 0c1.5-3 5-3.5 5-1s-5 1-5 1Z" />
    </>
  ),
  engraving: (
    <>
      <path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
  support: (
    <>
      <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
      <rect x="3" y="13" width="4" height="6" rx="1" />
      <rect x="17" y="13" width="4" height="6" rx="1" />
      <path d="M19 19c0 1.5-2 2.5-5 2.5" />
    </>
  ),
};

export function BadgeGlyph({ icon, className }: { icon?: string; className?: string }) {
  const glyph = BADGE_GLYPHS[icon ?? ''] ?? BADGE_GLYPHS.certified;
  return (
    <svg {...base({})} className={className} strokeWidth={1.1}>
      {glyph}
    </svg>
  );
}
