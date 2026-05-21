'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveColor } from '@force/shared';
import type {
  FloatingButton,
  FloatingButtonKind,
  FloatingWidgetConfig,
  StoreTheme,
} from '@force/shared';
import { InstagramBrandIcon, WhatsappBrandIcon, VolumeMaxIcon, VolumeMutedIcon } from './icons';

interface FloatingWidgetProps {
  config: FloatingWidgetConfig | undefined;
  theme: StoreTheme | undefined;
  isRtl: boolean;
}

const POSITION_CLASSES: Record<NonNullable<FloatingWidgetConfig['position']>, string> = {
  br: 'bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-6 right-4 md:right-6',
  bl: 'bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-6 left-4 md:left-6',
  tr: 'top-20 md:top-24 right-4 md:right-6',
  tl: 'top-20 md:top-24 left-4 md:left-6',
};

const EXPAND_CONTAINER_CLASS: Record<
  NonNullable<FloatingWidgetConfig['expandDirection']>,
  string
> = {
  up: 'flex-col-reverse items-center mb-3',
  down: 'flex-col items-center mt-3',
  left: 'flex-row-reverse items-center mr-3',
  right: 'flex-row items-center ml-3',
};

const KIND_DEFAULTS: Record<
  FloatingButtonKind,
  { bg: string; icon: string; label: string; labelAr: string }
> = {
  whatsapp: { bg: '#25D366', icon: '#ffffff', label: 'WhatsApp', labelAr: 'واتساب' },
  instagram: { bg: '#E4405F', icon: '#ffffff', label: 'Instagram', labelAr: 'إنستغرام' },
  phone: { bg: '#0EA5E9', icon: '#ffffff', label: 'Call', labelAr: 'اتصل' },
  email: { bg: '#6366F1', icon: '#ffffff', label: 'Email', labelAr: 'البريد' },
  music: { bg: '#F59E0B', icon: '#ffffff', label: 'Music', labelAr: 'موسيقى' },
  custom: { bg: '#6B7280', icon: '#ffffff', label: 'Link', labelAr: 'رابط' },
};

function resolveButtonHref(b: FloatingButton): string | null {
  switch (b.kind) {
    case 'whatsapp':
      if (!b.whatsappPhone) return null;
      return b.whatsappMessage
        ? `https://wa.me/${encodeURIComponent(b.whatsappPhone)}?text=${encodeURIComponent(b.whatsappMessage)}`
        : `https://wa.me/${encodeURIComponent(b.whatsappPhone)}`;
    case 'instagram':
      if (!b.instagramHandle) return null;
      return `https://instagram.com/${encodeURIComponent(b.instagramHandle.replace(/^@/, ''))}`;
    case 'phone':
      return b.phoneNumber ? `tel:${b.phoneNumber}` : null;
    case 'email':
      if (!b.emailAddress) return null;
      return b.emailSubject
        ? `mailto:${b.emailAddress}?subject=${encodeURIComponent(b.emailSubject)}`
        : `mailto:${b.emailAddress}`;
    case 'custom':
      return b.customHref ?? null;
    case 'music':
      return null; // music doesn't navigate — toggles audio
  }
}

// Whatsapp + Instagram are handled separately at the button-render level —
// they render full-bleed brand SVGs that include their own background.
// KindIcon below handles only the kinds that share the "circle bg +
// centered glyph" pattern: phone / email / music / custom.
function KindIcon({
  kind,
  color,
  isPlaying,
}: {
  kind: Exclude<FloatingButtonKind, 'whatsapp' | 'instagram'>;
  color: string;
  isPlaying?: boolean;
}) {
  const common = { width: 22, height: 22, fill: 'none', stroke: color, strokeWidth: 2 };
  switch (kind) {
    case 'phone':
      return (
        <svg viewBox="0 0 24 24" {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.9.37 1.78.7 2.6a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.48-1.48a2 2 0 0 1 2.11-.45c.83.33 1.7.57 2.6.7A2 2 0 0 1 22 16.92z" />
        </svg>
      );
    case 'email':
      return (
        <svg viewBox="0 0 24 24" {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      );
    case 'music':
      // Two states: max (currently playing) / muted (paused or idle). Both
      // SVGs use `stroke="currentColor"` so the merchant's iconColor flows
      // through via the wrapper's color CSS. Ahmad's request 2026-05-21.
      return (
        <span className="block h-[22px] w-[22px]" style={{ color }}>
          {isPlaying ? (
            <VolumeMaxIcon className="h-full w-full" />
          ) : (
            <VolumeMutedIcon className="h-full w-full" />
          )}
        </span>
      );
    case 'custom':
      return (
        <svg viewBox="0 0 24 24" {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      );
  }
}

function ButtonRender({
  button,
  theme,
  isRtl,
  onMusicToggle,
  musicPlaying,
}: {
  button: FloatingButton;
  theme: StoreTheme | undefined;
  isRtl: boolean;
  onMusicToggle: (b: FloatingButton) => void;
  musicPlaying: string | null;
}) {
  const defaults = KIND_DEFAULTS[button.kind];
  const isBrandKind = button.kind === 'whatsapp' || button.kind === 'instagram';
  // Brand kinds embed their own gradient/color background — we paint the
  // button transparent and let the SVG fill the circle. Merchant bgColor
  // override is intentionally ignored here (brand color IS the icon).
  const bg = isBrandKind
    ? 'transparent'
    : button.bgColor
      ? (resolveColor(button.bgColor, theme as StoreTheme) ?? button.bgColor)
      : defaults.bg;
  const iconColor = button.iconColor
    ? (resolveColor(button.iconColor, theme as StoreTheme) ?? button.iconColor)
    : defaults.icon;
  const label = isRtl
    ? (button.labelAr ?? button.label ?? defaults.labelAr)
    : (button.label ?? defaults.label);
  const isActive = button.kind === 'music' && musicPlaying === button.id;

  const baseClass =
    'group relative flex h-12 w-12 items-center justify-center rounded-full shadow-lg overflow-hidden transition-all duration-200 hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-primary';

  const sharedProps = {
    className: baseClass,
    style: { backgroundColor: bg },
    'aria-label': label,
    title: label,
  };

  // Merchant-supplied `iconUrl` always wins for any kind — they uploaded
  // their own icon, render it. Otherwise: brand kinds get the full-bleed
  // SVG (gradient + glyph), other kinds get a small centered KindIcon
  // over the button's bg color.
  const inner = (
    <>
      {button.iconUrl ? (
        <img src={button.iconUrl} alt="" className="h-6 w-6 object-contain" />
      ) : button.kind === 'whatsapp' ? (
        <WhatsappBrandIcon className="h-full w-full" />
      ) : button.kind === 'instagram' ? (
        <InstagramBrandIcon className="h-full w-full" />
      ) : (
        <KindIcon kind={button.kind} color={iconColor} isPlaying={isActive} />
      )}
      {isActive && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full ring-2 ring-white animate-pulse"
        />
      )}
    </>
  );

  if (button.kind === 'music') {
    return (
      <button type="button" onClick={() => onMusicToggle(button)} {...sharedProps}>
        {inner}
      </button>
    );
  }

  const href = resolveButtonHref(button);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...sharedProps}>
      {inner}
    </a>
  );
}

export function FloatingWidget({ config, theme, isRtl }: FloatingWidgetProps) {
  const [expanded, setExpanded] = useState(false);
  const [musicPlayingId, setMusicPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize expanded state from config — runs once on mount.
  useEffect(() => {
    setExpanded(config?.startExpanded === true);
  }, [config?.startExpanded]);

  // Pause audio when tab loses focus (good citizen behavior — auto-
  // playing background music keeps playing in inactive tabs otherwise).
  useEffect(() => {
    const onVisChange = () => {
      if (document.hidden && audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
        setMusicPlayingId(null);
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, []);

  const onMusicToggle = useCallback(
    (button: FloatingButton) => {
      if (!button.musicUrl) return;
      if (musicPlayingId === button.id) {
        audioRef.current?.pause();
        setMusicPlayingId(null);
        return;
      }
      // Switch to a new track (or start fresh).
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = button.musicUrl;
      } else {
        audioRef.current = new Audio(button.musicUrl);
      }
      audioRef.current.loop = button.musicLoop !== false;
      audioRef.current.volume = 0.6;
      audioRef.current.play().then(
        () => setMusicPlayingId(button.id),
        () => setMusicPlayingId(null) // autoplay blocked or missing source
      );
    },
    [musicPlayingId]
  );

  if (!config?.enabled) return null;
  const buttons = config.buttons ?? [];
  const position = config.position ?? 'br';
  const expandDirection =
    config.expandDirection ?? (position === 'tr' || position === 'tl' ? 'down' : 'up');

  // Position-aware container — handles RTL by swapping left/right anchor.
  const positionClass = (() => {
    const pos = position;
    if (!isRtl) return POSITION_CLASSES[pos];
    // Mirror left/right for RTL stores so the widget sits on the visually-
    // expected edge (storefront UX, not literal CSS direction).
    const mirror: Record<typeof pos, typeof pos> = { br: 'bl', bl: 'br', tr: 'tl', tl: 'tr' };
    return POSITION_CLASSES[mirror[pos]];
  })();

  const responsiveHideClass = `${config.hideOnMobile ? 'hidden md:flex' : 'flex'} ${
    config.hideOnDesktop ? 'md:hidden' : ''
  }`;

  const toggleBg = config.toggleBgColor
    ? (resolveColor(config.toggleBgColor, theme as StoreTheme) ?? config.toggleBgColor)
    : 'hsl(var(--primary))';

  return (
    <div className={`fixed z-[60] ${responsiveHideClass} flex-col ${positionClass}`}>
      {/* Expanded button stack — only rendered when expanded AND there's
          at least one configured button. Direction handled by container
          flex direction. */}
      {expanded && buttons.length > 0 && (
        <div className={`flex gap-3 ${EXPAND_CONTAINER_CLASS[expandDirection]}`}>
          {buttons.map(b => (
            <ButtonRender
              key={b.id}
              button={b}
              theme={theme}
              isRtl={isRtl}
              onMusicToggle={onMusicToggle}
              musicPlaying={musicPlayingId}
            />
          ))}
        </div>
      )}
      {/* The always-visible collapse-toggle. Hidden behavior when the
          merchant configured zero buttons — show the toggle anyway since
          we have a configured widget; nothing else to do though. */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        aria-label={
          isRtl ? (config.toggleLabelAr ?? 'القائمة العائمة') : (config.toggleLabel ?? 'Open menu')
        }
        className="group relative flex h-14 w-14 items-center justify-center rounded-full shadow-xl transition-all duration-200 hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-primary"
        style={{ backgroundColor: toggleBg }}
      >
        {config.toggleIconUrl ? (
          <img src={config.toggleIconUrl} alt="" className="h-7 w-7 object-contain" />
        ) : (
          <svg
            viewBox="0 0 24 24"
            width={26}
            height={26}
            fill="none"
            stroke="#fff"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-300 ${expanded ? 'rotate-45' : ''}`}
          >
            {expanded ? (
              <path d="M18 6L6 18M6 6l12 12" />
            ) : (
              <>
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </>
            )}
          </svg>
        )}
      </button>
    </div>
  );
}
