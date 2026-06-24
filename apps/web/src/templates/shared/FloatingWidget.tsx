'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { resolveColor } from '@force/shared';
import type {
  FloatingButton,
  FloatingButtonKind,
  FloatingWidgetConfig,
  StoreTheme,
} from '@force/shared';
import { InstagramGlyphIcon, WhatsappGlyphIcon, VolumeMaxIcon, VolumeMutedIcon } from './icons';
import type { StoreContact, StoreSocials } from '../types';

interface FloatingWidgetProps {
  config: FloatingWidgetConfig | undefined;
  theme: StoreTheme | undefined;
  isRtl: boolean;
  /** Store-level contact info — fallback source for WhatsApp button's
   *  phone when the merchant didn't set one explicitly on the button.
   *  Saves them re-typing data that lives in /branding > contact. */
  contact?: Pick<StoreContact, 'whatsapp' | 'phone'>;
  /** Store-level socials — fallback for social platform handles/URLs. */
  socials?: Pick<
    StoreSocials,
    | 'instagram'
    | 'whatsapp'
    | 'tiktok'
    | 'snapchat'
    | 'youtube'
    | 'facebook'
    | 'twitter'
    | 'telegram'
  >;
}

/** Extract an Instagram handle from a URL or @handle string. Returns null
 *  when no handle can be recovered. Accepts "@wadyaljuz", "wadyaljuz",
 *  "https://instagram.com/wadyaljuz", "https://www.instagram.com/wadyaljuz/". */
function instagramHandleFromUrl(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already a bare handle (no slash, no protocol)
  if (!/^https?:|\//.test(trimmed)) return trimmed.replace(/^@/, '');
  const match = trimmed.match(/instagram\.com\/([^/?#]+)/i);
  return match ? match[1] : null;
}

/** Extract a bare TikTok handle from a @handle string or a tiktok.com URL.
 *  Returns null when no handle can be recovered. */
function tiktokHandleFromAny(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Bare handle or @handle — no slash / protocol
  if (!/^https?:|\//.test(trimmed)) return trimmed.replace(/^@/, '');
  const match = trimmed.match(/tiktok\.com\/@([^/?#]+)/i);
  return match ? match[1] : null;
}

/** Extract a bare Snapchat username from a @handle string or a snapchat.com URL. */
function snapchatHandleFromAny(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^https?:|\//.test(trimmed)) return trimmed.replace(/^@/, '');
  const match = trimmed.match(/snapchat\.com\/add\/([^/?#]+)/i);
  return match ? match[1] : null;
}

/** Extract a bare X (Twitter) handle from a @handle string or an x.com / twitter.com URL. */
function xHandleFromAny(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^https?:|\//.test(trimmed)) return trimmed.replace(/^@/, '');
  const match = trimmed.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
  return match ? match[1] : null;
}

/** Extract a bare Telegram handle from a @handle string or a t.me URL. */
function telegramHandleFromAny(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^https?:|\//.test(trimmed)) return trimmed.replace(/^@/, '');
  const match = trimmed.match(/t\.me\/([^/?#]+)/i);
  return match ? match[1] : null;
}

/** Validate that a URL is http(s). Returns the URL unchanged when valid, else null. */
function safeHttpUrl(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  return /^https?:\/\/.+/.test(trimmed) ? trimmed : null;
}

/** Extract digits-only phone from a wa.me URL or raw phone string. */
function whatsappDigitsFromAny(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
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
  tiktok: { bg: '#000000', icon: '#ffffff', label: 'TikTok', labelAr: 'تيك توك' },
  snapchat: { bg: '#FFFC00', icon: '#000000', label: 'Snapchat', labelAr: 'سناب شات' },
  youtube: { bg: '#FF0000', icon: '#ffffff', label: 'YouTube', labelAr: 'يوتيوب' },
  facebook: { bg: '#1877F2', icon: '#ffffff', label: 'Facebook', labelAr: 'فيسبوك' },
  x: { bg: '#000000', icon: '#ffffff', label: 'X', labelAr: 'إكس' },
  telegram: { bg: '#26A5E4', icon: '#ffffff', label: 'Telegram', labelAr: 'تيليغرام' },
};

function resolveButtonHref(
  b: FloatingButton,
  fallback: {
    contact?: Pick<StoreContact, 'whatsapp' | 'phone'>;
    socials?: Pick<
      StoreSocials,
      | 'instagram'
      | 'whatsapp'
      | 'tiktok'
      | 'snapchat'
      | 'youtube'
      | 'facebook'
      | 'twitter'
      | 'telegram'
    >;
  }
): string | null {
  switch (b.kind) {
    case 'whatsapp': {
      // Inherit from store contact when the button doesn't carry its own
      // phone — most merchants already typed it in /branding > contact;
      // re-typing here would just rot. Order: button override → store
      // contact.whatsapp → store socials.whatsapp URL → null.
      const phone =
        whatsappDigitsFromAny(b.whatsappPhone) ??
        whatsappDigitsFromAny(fallback.contact?.whatsapp) ??
        whatsappDigitsFromAny(fallback.socials?.whatsapp);
      if (!phone) return null;
      return b.whatsappMessage
        ? `https://wa.me/${phone}?text=${encodeURIComponent(b.whatsappMessage)}`
        : `https://wa.me/${phone}`;
    }
    case 'instagram': {
      const handle =
        instagramHandleFromUrl(b.instagramHandle) ??
        instagramHandleFromUrl(fallback.socials?.instagram);
      if (!handle) return null;
      return `https://instagram.com/${encodeURIComponent(handle)}`;
    }
    case 'phone':
      return b.phoneNumber
        ? `tel:${b.phoneNumber}`
        : fallback.contact?.phone
          ? `tel:${fallback.contact.phone}`
          : null;
    case 'email':
      if (!b.emailAddress) return null;
      return b.emailSubject
        ? `mailto:${b.emailAddress}?subject=${encodeURIComponent(b.emailSubject)}`
        : `mailto:${b.emailAddress}`;
    case 'custom':
      return b.customHref ?? null;
    case 'music':
      return null; // music doesn't navigate — toggles audio
    case 'tiktok': {
      const handle =
        tiktokHandleFromAny(b.tiktokHandle) ?? tiktokHandleFromAny(fallback.socials?.tiktok);
      if (!handle) return null;
      return `https://tiktok.com/@${encodeURIComponent(handle)}`;
    }
    case 'snapchat': {
      const handle =
        snapchatHandleFromAny(b.snapchatHandle) ??
        snapchatHandleFromAny(fallback.socials?.snapchat);
      if (!handle) return null;
      return `https://snapchat.com/add/${encodeURIComponent(handle)}`;
    }
    case 'youtube': {
      const url = safeHttpUrl(b.youtubeUrl) ?? safeHttpUrl(fallback.socials?.youtube);
      return url;
    }
    case 'facebook': {
      const url = safeHttpUrl(b.facebookUrl) ?? safeHttpUrl(fallback.socials?.facebook);
      return url;
    }
    case 'x': {
      // StoreSocials uses `twitter` field name; 'x' kind maps to it.
      const handle = xHandleFromAny(b.xHandle) ?? xHandleFromAny(fallback.socials?.twitter);
      if (!handle) return null;
      return `https://x.com/${encodeURIComponent(handle)}`;
    }
    case 'telegram': {
      const handle =
        telegramHandleFromAny(b.telegramHandle) ??
        telegramHandleFromAny(fallback.socials?.telegram);
      if (!handle) return null;
      return `https://t.me/${encodeURIComponent(handle)}`;
    }
  }
}

// Every kind renders its icon at the same physical size (`h-7 w-7` = 28px)
// inside the 48px-circle button. Ahmad 2026-05-21: "all icons same size".
// Brand kinds use the white glyph (no embedded bg) over a brand-color
// button bg; themed kinds use a stroke icon over the merchant's bg color.
const ICON_BOX_CLASS = 'h-7 w-7';

// Full-color brand PNGs (512×512, circle bg included). For these three
// kinds the button renders the PNG edge-to-edge with a transparent bg so
// the PNG's own colored circle shows cleanly without a double-ring effect.
const WIDGET_PNG_ICONS: Partial<Record<FloatingButtonKind, string>> = {
  whatsapp: '/social-icons/whatsapp.png',
  instagram: '/social-icons/instagram.png',
  tiktok: '/social-icons/tiktok.png',
};

function KindIcon({
  kind,
  color,
  isPlaying,
}: {
  kind: FloatingButtonKind;
  color: string;
  isPlaying?: boolean;
}) {
  const pngSrc = WIDGET_PNG_ICONS[kind];
  if (pngSrc) {
    // Render the full-color PNG; the caller's button bg is set to
    // transparent for these kinds so the PNG circle is unobstructed.
    return (
      <Image src={pngSrc} alt="" width={28} height={28} className={ICON_BOX_CLASS} unoptimized />
    );
  }
  switch (kind) {
    case 'whatsapp':
      return <WhatsappGlyphIcon className={ICON_BOX_CLASS} />;
    case 'instagram':
      return <InstagramGlyphIcon className={ICON_BOX_CLASS} />;
    case 'phone':
      return (
        <svg
          viewBox="0 0 24 24"
          className={ICON_BOX_CLASS}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.9.37 1.78.7 2.6a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.48-1.48a2 2 0 0 1 2.11-.45c.83.33 1.7.57 2.6.7A2 2 0 0 1 22 16.92z" />
        </svg>
      );
    case 'email':
      return (
        <svg
          viewBox="0 0 24 24"
          className={ICON_BOX_CLASS}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      );
    case 'music':
      // Two states: max (currently playing) / muted (paused or idle).
      // currentColor lets the merchant's iconColor flow through.
      return (
        <span className={`block ${ICON_BOX_CLASS}`} style={{ color }}>
          {isPlaying ? (
            <VolumeMaxIcon className="h-full w-full" />
          ) : (
            <VolumeMutedIcon className="h-full w-full" />
          )}
        </span>
      );
    case 'custom':
      return (
        <svg
          viewBox="0 0 24 24"
          className={ICON_BOX_CLASS}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      );
    case 'tiktok':
      // TikTok musical-note glyph (simplified)
      return (
        <svg viewBox="0 0 24 24" className={ICON_BOX_CLASS} fill={color}>
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.34 6.34 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.79 1.52V6.76a4.86 4.86 0 0 1-1.02-.07z" />
        </svg>
      );
    case 'snapchat':
      // Snapchat ghost glyph
      return (
        <svg viewBox="0 0 24 24" className={ICON_BOX_CLASS} fill={color}>
          <path d="M12.166 2c.93 0 4.04.256 5.524 3.516.44.975.334 2.633.253 3.9l-.012.189c.023.013.06.027.115.038.23.046.539.037.87-.117a1.17 1.17 0 0 1 .493-.109c.156 0 .31.034.447.1.402.19.645.53.645.904 0 .554-.443.984-1.316 1.279-.08.027-.165.054-.254.08-.389.12-.875.27-1.038.583-.083.16-.066.37.053.625l.007.016c.34.789 1.376 2.652 3.472 3.001.172.03.297.18.297.356 0 .04-.006.079-.018.116-.155.47-.972.819-2.498 1.066-.063.01-.122.094-.173.243-.06.178-.097.395-.132.595-.035.205-.073.419-.143.583a.52.52 0 0 1-.488.33c-.138 0-.284-.039-.458-.096-.376-.125-.887-.296-1.66-.296-.473 0-.956.053-1.433.158-.848.187-1.558.75-2.175 1.24-.509.4-1.048.82-1.727.82-.014 0-.028 0-.043-.002-.639-.03-1.145-.418-1.614-.791-.614-.49-1.32-1.046-2.163-1.23a6.62 6.62 0 0 0-1.433-.158c-.776 0-1.289.172-1.665.297-.173.057-.32.096-.46.096a.52.52 0 0 1-.487-.33c-.07-.165-.108-.38-.143-.585-.035-.199-.072-.416-.133-.593-.05-.149-.109-.232-.168-.242-1.527-.248-2.344-.598-2.499-1.069a.436.436 0 0 1-.018-.115c0-.176.125-.326.297-.356 2.096-.348 3.132-2.21 3.472-3.001l.007-.016c.119-.255.136-.465.053-.625-.163-.313-.649-.463-1.037-.583-.09-.027-.175-.053-.255-.08C3.443 11.484 3 11.054 3 10.5c0-.374.244-.714.645-.904a1.07 1.07 0 0 1 .447-.1c.185 0 .358.044.493.109.338.157.648.162.87.117.058-.012.097-.027.118-.04l-.012-.188c-.08-1.267-.186-2.924.254-3.9C7.296 2.257 10.34 2 11.27 2h.896z" />
        </svg>
      );
    case 'youtube':
      // YouTube play-button glyph
      return (
        <svg viewBox="0 0 24 24" className={ICON_BOX_CLASS} fill={color}>
          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      );
    case 'facebook':
      // Facebook 'f' glyph
      return (
        <svg viewBox="0 0 24 24" className={ICON_BOX_CLASS} fill={color}>
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
        </svg>
      );
    case 'x':
      // X (Twitter) 'X' glyph
      return (
        <svg viewBox="0 0 24 24" className={ICON_BOX_CLASS} fill={color}>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
    case 'telegram':
      // Telegram paper-plane glyph
      return (
        <svg viewBox="0 0 24 24" className={ICON_BOX_CLASS} fill={color}>
          <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
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
  contact,
  socials,
}: {
  button: FloatingButton;
  theme: StoreTheme | undefined;
  isRtl: boolean;
  onMusicToggle: (b: FloatingButton) => void;
  musicPlaying: string | null;
  contact?: Pick<StoreContact, 'whatsapp' | 'phone'>;
  socials?: Pick<
    StoreSocials,
    | 'instagram'
    | 'whatsapp'
    | 'tiktok'
    | 'snapchat'
    | 'youtube'
    | 'facebook'
    | 'twitter'
    | 'telegram'
  >;
}) {
  const defaults = KIND_DEFAULTS[button.kind];
  // Every kind uses merchant pick OR the kind's default color. For brand
  // kinds (whatsapp/instagram), the default IS the brand color so the
  // button reads as the brand without the SVG needing to embed its bg.
  // Same glyph size across kinds — Ahmad 2026-05-21 "all icons same size".
  //
  // 2026-06-24 — when `floatingWidgetOriginalColor` is true on the theme,
  // ignore per-button color overrides and always use the KIND_DEFAULTS (the
  // official brand bg + icon color). This restores brand identity for every
  // button even if the merchant previously set custom colors on individual
  // buttons. The per-button overrides stay saved so the merchant can toggle
  // the flag back off and get their customizations back.
  const useOriginal = theme?.floatingWidgetOriginalColor === true;
  const bg = useOriginal
    ? defaults.bg
    : button.bgColor
      ? (resolveColor(button.bgColor, theme as StoreTheme) ?? button.bgColor)
      : defaults.bg;
  const iconColor = useOriginal
    ? defaults.icon
    : button.iconColor
      ? (resolveColor(button.iconColor, theme as StoreTheme) ?? button.iconColor)
      : defaults.icon;
  const label = isRtl
    ? (button.labelAr ?? button.label ?? defaults.labelAr)
    : (button.label ?? defaults.label);
  const isActive = button.kind === 'music' && musicPlaying === button.id;

  const baseClass =
    'group relative flex h-12 w-12 items-center justify-center rounded-full shadow-lg overflow-hidden transition-all duration-200 hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-primary';

  // For PNG-icon kinds (whatsapp/instagram/tiktok) the PNG already carries
  // its own colored circle. Rendering a button bg behind it creates a
  // circle-on-circle double-ring. Use transparent so the PNG circle shows
  // cleanly against whatever surface the widget sits on.
  const hasPngIcon = button.kind in WIDGET_PNG_ICONS;
  const sharedProps = {
    className: baseClass,
    style: { backgroundColor: hasPngIcon ? 'transparent' : bg },
    'aria-label': label,
    title: label,
  };

  const inner = (
    <>
      {button.iconUrl ? (
        <img src={button.iconUrl} alt="" className="h-7 w-7 object-contain" />
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

  const href = resolveButtonHref(button, { contact, socials });
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...sharedProps}>
      {inner}
    </a>
  );
}

export function FloatingWidget({ config, theme, isRtl, contact, socials }: FloatingWidgetProps) {
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
              contact={contact}
              socials={socials}
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
