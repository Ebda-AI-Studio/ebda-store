'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveColor } from '@force/shared';
import type {
  FloatingButton,
  FloatingButtonKind,
  FloatingWidgetConfig,
  StoreTheme,
} from '@force/shared';

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

function KindIcon({ kind, color }: { kind: FloatingButtonKind; color: string }) {
  const common = { width: 22, height: 22, fill: 'none', stroke: color, strokeWidth: 2 };
  switch (kind) {
    case 'whatsapp':
      return (
        <svg viewBox="0 0 24 24" width={common.width} height={common.height} fill={color}>
          <path d="M17.5 14.4c-.3-.1-1.7-.8-1.9-.9-.3-.1-.4-.1-.6.1-.2.3-.7.9-.8 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.4-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5C10.4 9 9.8 7.6 9.6 7.1c-.2-.5-.5-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.2 0 1.3.9 2.6 1.1 2.8.1.2 1.8 2.8 4.5 3.9.6.3 1.1.4 1.5.5.6.2 1.2.2 1.7.1.5-.1 1.7-.7 1.9-1.3.2-.7.2-1.2.2-1.3-.1-.1-.3-.2-.6-.4zM12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.6 1.4 5.1L2 22l5-1.4c1.4.8 3.1 1.2 4.9 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2zm6 14c-.6 1-1.7 1.7-3 1.9-.3.1-.8.2-1.6 0-.4-.1-1-.3-1.7-.6-3.2-1.4-5.3-4.7-5.5-4.9-.2-.2-1.3-1.8-1.3-3.4 0-1.7.8-2.4 1.2-2.7.3-.3.6-.4.9-.4h.5c.2 0 .4 0 .6.5.2.5.7 1.8.8 2 .1.2.1.4 0 .5-.1.2-.2.3-.3.5-.1.1-.3.3-.4.4-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1.9 2 1.2 2.3 1.4.3.1.5.1.6-.1.2-.2.7-.8.9-1.1.2-.3.4-.2.6-.1.2.1 1.5.7 1.7.8.3.1.5.2.5.3.1.2.1.9-.2 1.4z" />
        </svg>
      );
    case 'instagram':
      return (
        <svg viewBox="0 0 24 24" {...common} strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="20" height="20" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.5" cy="6.5" r="1" fill={color} stroke="none" />
        </svg>
      );
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
      return (
        <svg viewBox="0 0 24 24" {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
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
  const bg = button.bgColor
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
    'group relative flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all duration-200 hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-primary';

  const sharedProps = {
    className: baseClass,
    style: { backgroundColor: bg },
    'aria-label': label,
    title: label,
  };

  const inner = (
    <>
      {button.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={button.iconUrl} alt="" className="h-6 w-6 object-contain" />
      ) : (
        <KindIcon kind={button.kind} color={iconColor} />
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
          // eslint-disable-next-line @next/next/no-img-element
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
