'use client';

import * as React from 'react';
import { parse, toRGBA } from 'color-bits';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useLanguage } from '@/contexts/LanguageContext';
import { BRAND, BRAND_MARKETING_URL } from '@force/shared';

// ---------------------------------------------------------------------------
// color-bits helpers
// ---------------------------------------------------------------------------

function getRGBA(color: string): { r: number; g: number; b: number; a: number } {
  try {
    return toRGBA(parse(color));
  } catch {
    return { r: 107, g: 114, b: 128, a: 255 };
  }
}

function colorWithOpacity(
  rgba: { r: number; g: number; b: number; a: number },
  opacity: number
): string {
  return `rgba(${rgba.r},${rgba.g},${rgba.b},${opacity})`;
}

// ---------------------------------------------------------------------------
// Site config
// ---------------------------------------------------------------------------

export const siteConfig = {
  name: BRAND.product.nameEn,
  hero: {
    description: 'The AI-powered commerce platform built for Egyptian businesses.',
  },
  footerLinks: {
    Company: [
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
      { label: 'Blog', href: '/blog' },
    ],
    Product: [
      { label: 'Features', href: '/features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Stores', href: '/stores' },
    ],
    Resources: [
      { label: 'Docs', href: '/docs' },
      { label: 'Support', href: '/support' },
      { label: 'Status', href: '/status' },
    ],
  },
} as const;

// ---------------------------------------------------------------------------
// useMediaQuery
// ---------------------------------------------------------------------------

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState<boolean>(false);

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

// ---------------------------------------------------------------------------
// Highlight — orange accent text
// ---------------------------------------------------------------------------

export function Highlight({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn('text-primary font-semibold', className)}>{children}</span>;
}

// ---------------------------------------------------------------------------
// FlickeringGrid
// ---------------------------------------------------------------------------

export interface FlickeringGridProps {
  /** CSS colour string for the grid squares */
  color?: string;
  /** Fraction of grid cells that are "on" at any moment (0–1) */
  flickerChance?: number;
  /** Fraction of cells visible at the start (0–1) */
  maxOpacity?: number;
  /** Repaint interval in ms */
  repaintInterval?: number;
  /** Cell size in px */
  squareSize?: number;
  /** Gap between cells in px */
  gridGap?: number;
  /** Extra className on the <canvas> */
  className?: string;
  /** Width override */
  width?: number;
  /** Height override */
  height?: number;
}

export function FlickeringGrid({
  color = '#6B7280',
  flickerChance = 0.3,
  maxOpacity = 0.3,
  repaintInterval = 50,
  squareSize = 4,
  gridGap = 6,
  className,
  width,
  height,
}: FlickeringGridProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const animFrameRef = React.useRef<number | null>(null);
  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const rgba = React.useMemo(() => getRGBA(color), [color]);

  const drawGrid = React.useCallback(
    (
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      cols: number,
      rows: number,
      opacities: Float32Array
    ) => {
      ctx.clearRect(0, 0, w, h);
      const step = squareSize + gridGap;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;
          const opacity = opacities[idx] ?? 0;
          if (opacity <= 0) continue;
          ctx.fillStyle = colorWithOpacity(rgba, opacity);
          ctx.fillRect(col * step, row * step, squareSize, squareSize);
        }
      }
    },
    [rgba, squareSize, gridGap]
  );

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const step = squareSize + gridGap;
    let w = width ?? container.offsetWidth;
    let h = height ?? container.offsetHeight;
    let cols = Math.ceil(w / step);
    let rows = Math.ceil(h / step);
    let opacities = new Float32Array(cols * rows);

    const resize = () => {
      w = width ?? container.offsetWidth;
      h = height ?? container.offsetHeight;
      canvas.width = w;
      canvas.height = h;
      cols = Math.ceil(w / step);
      rows = Math.ceil(h / step);
      opacities = new Float32Array(cols * rows);
      // seed
      for (let i = 0; i < opacities.length; i++) {
        opacities[i] = Math.random() < 0.5 ? Math.random() * maxOpacity : 0;
      }
    };

    resize();

    const ro = new ResizeObserver(() => {
      resize();
    });
    ro.observe(container);

    let visible = false;

    const tick = () => {
      if (!visible) return;
      for (let i = 0; i < opacities.length; i++) {
        if (Math.random() < flickerChance) {
          opacities[i] = Math.random() < 0.5 ? Math.random() * maxOpacity : 0;
        }
      }
      animFrameRef.current = requestAnimationFrame(() => {
        drawGrid(ctx, w, h, cols, rows, opacities);
      });
    };

    intervalRef.current = setInterval(tick, repaintInterval);

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? false;
      },
      { threshold: 0 }
    );
    io.observe(container);

    return () => {
      ro.disconnect();
      io.disconnect();
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [
    color,
    flickerChance,
    maxOpacity,
    repaintInterval,
    squareSize,
    gridGap,
    width,
    height,
    rgba,
    drawGrid,
  ]);

  return (
    <div ref={containerRef} className={cn('relative w-full h-full', className)}>
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FooterLink column
// ---------------------------------------------------------------------------

interface FooterColumnProps {
  title: string;
  links: ReadonlyArray<{ label: string; href: string }>;
}

function FooterColumn({ title, links }: FooterColumnProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-semibold text-white tracking-wide">{title}</p>
      <ul className="flex flex-col gap-2">
        {links.map(link => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-sm text-muted-foreground hover:text-white transition-colors"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FlickeringFooter (main export)
// ---------------------------------------------------------------------------

export function FlickeringFooter() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isTablet = useMediaQuery('(min-width: 640px)');
  const { t } = useLanguage();

  // Big text: "Ebda" on desktop, "Force" on tablet, nothing on mobile
  const bigText = isDesktop ? BRAND.product.nameEn : isTablet ? BRAND.product.nameEn : null;

  // Translated footer link columns — column titles + link labels
  // Real destinations only — landing section anchors + live contact channels.
  // (The old /about, /pricing, /docs… paths don't exist on the platform host and
  // 404'd into the legacy landing.)
  const translatedFooterLinks: Array<{
    title: string;
    links: ReadonlyArray<{ label: string; href: string }>;
  }> = [
    {
      title: t('Explore', 'استكشف'),
      links: [
        { label: t('What we do', 'ماذا نقدم'), href: '#features' },
        { label: t('The AI edge', 'ميزة الذكاء الاصطناعي'), href: '#aeo-geo' },
      ],
    },
    {
      title: t('Get in touch', 'تواصل معنا'),
      links: [
        { label: t('Email', 'البريد'), href: `mailto:${BRAND.supportEmail}` },
        { label: t('Ebda', 'ابدأ'), href: BRAND_MARKETING_URL },
      ],
    },
  ];

  return (
    <footer className="relative w-full bg-black overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Link grid                                                            */}
      {/* ------------------------------------------------------------------ */}
      <div className="relative z-10 border-t border-border/30 px-6 py-16">
        <div className="max-w-6xl mx-auto flex flex-col gap-12 md:gap-0 md:flex-row md:justify-between">
          {/* Brand lockup — approved Ebda open-door mark (public/logo.svg, gold). */}
          <div className="flex flex-col gap-4 max-w-xs">
            <div className="flex items-center gap-2.5">
              <img
                src="/lockup-dark.svg"
                alt={BRAND.product.nameEn}
                className="h-10 w-auto"
                width={120}
                height={40}
              />
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t(
                siteConfig.hero.description,
                'منصة التجارة الإلكترونية المدعومة بالذكاء الاصطناعي للأعمال المصرية.'
              )}
            </p>
            <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              <a
                href={`mailto:${BRAND.supportEmail}`}
                className="hover:text-primary transition-colors"
              >
                {BRAND.supportEmail}
              </a>
            </div>
          </div>

          {/* Link columns */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-10">
            {translatedFooterLinks.map(({ title, links }) => (
              <FooterColumn key={title} title={title} links={links} />
            ))}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Big flickering text mask                                             */}
      {/* ------------------------------------------------------------------ */}
      {bigText && (
        <div className="relative z-0 w-full overflow-hidden" style={{ height: '14rem' }}>
          {/* Canvas fills the band */}
          <FlickeringGrid
            color="#6B7280"
            flickerChance={0.15}
            maxOpacity={0.25}
            repaintInterval={60}
            squareSize={4}
            gridGap={6}
            className="absolute inset-0"
          />

          {/* Masked text sits on top — canvas shows through the text shape via mix-blend-mode */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            aria-hidden="true"
          >
            <span
              className={cn(
                'font-black uppercase tracking-tighter leading-none text-transparent select-none',
                isDesktop ? 'text-[10rem]' : 'text-[7rem]'
              )}
              style={{
                WebkitTextStroke: '1px rgba(255,255,255,0.06)',
                color: 'transparent',
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                backgroundImage:
                  'linear-gradient(135deg, rgba(255,110,1,0.18) 0%, rgba(255,255,255,0.10) 100%)',
              }}
            >
              {bigText}
            </span>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Bottom bar                                                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="relative z-10 border-t border-border/20 px-6 py-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-xs text-muted-foreground/60">
            &copy; {new Date().getFullYear()} Ebda.{' '}
            {t('All rights reserved.', 'جميع الحقوق محفوظة.')}
          </p>
          <div className="flex items-center gap-4">
            <Link
              href="/privacy"
              className="text-xs text-muted-foreground/60 hover:text-white transition-colors"
            >
              {t('Privacy', 'الخصوصية')}
            </Link>
            <Link
              href="/terms"
              className="text-xs text-muted-foreground/60 hover:text-white transition-colors"
            >
              {t('Terms', 'الشروط')}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
