'use client';

/**
 * Hero video: a muted, looping, decorative video laid OVER the slide's existing
 * poster image. The poster (passed as `children`, or an <img> built from
 * `poster`) is always the base layer and is what server HTML contains, so the
 * LCP element, the box size and the no-JS view are exactly what they were
 * before a video existed.
 *
 * The <video> mounts only after hydration, and only when ALL hold:
 *   - the visitor does not prefer reduced motion,
 *   - the connection is not Save-Data,
 *   - the video has not errored (404, unsupported codec, autoplay refused).
 * Otherwise nothing is rendered over the poster, so there is no broken video
 * element and no layout shift. Never plays sound.
 *
 * Eligibility is read with useSyncExternalStore: the server and the hydration
 * pass see "off", the first client commit after hydration sees the real answer,
 * so a reduced-motion visitor never gets a video mounted and torn down.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AutoplayToggle } from '../../templates/shared/AutoplayToggle';
import { useLanguage } from '../../contexts/LanguageContext';

/** Arabic-first labels when rendered outside a LanguageProvider (isolated renders). */
function useT(): (en: string, ar: string) => string {
  try {
    return useLanguage().t;
  } catch {
    return (_en, ar) => ar;
  }
}

export interface HeroVideoProps {
  src: string;
  /** Used instead of `src` at or below `mobileQuery`. */
  srcMobile?: string;
  /** Poster image URL, used only when no `children` are given: it is then both the base <img> and the video's poster. With children, the children ARE the poster and the video stays transparent until its first frame. */
  poster?: string;
  alt?: string;
  /** How the video fills the box: must match the poster's fit (`contain` for a framed hero). */
  fit?: 'cover' | 'contain';
  /** CSS object-position matching the poster's focus (B1-32). */
  position?: string;
  /** Media query that picks `srcMobile`. Match the slide's image art direction. */
  mobileQuery?: string;
  /** False pauses the video (slides of a carousel that are not showing). */
  active?: boolean;
  /** The existing poster element. Rendered untouched under the video. */
  children?: ReactNode;
}

type Mode = 'off' | 'desktop' | 'mobile';

const REDUCED = '(prefers-reduced-motion: reduce)';

interface NetworkInformationLike {
  saveData?: boolean;
  addEventListener?: (type: 'change', cb: () => void) => void;
  removeEventListener?: (type: 'change', cb: () => void) => void;
}

const connection = (): NetworkInformationLike | undefined =>
  (navigator as Navigator & { connection?: NetworkInformationLike }).connection;

function readMode(mobileQuery: string): Mode {
  if (window.matchMedia(REDUCED).matches) return 'off';
  if (connection()?.saveData) return 'off';
  return window.matchMedia(mobileQuery).matches ? 'mobile' : 'desktop';
}

export function HeroVideo({
  src,
  srcMobile,
  poster,
  alt = '',
  fit = 'cover',
  position,
  mobileQuery = '(max-width: 767px)',
  active = true,
  children,
}: HeroVideoProps) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const mqs = [window.matchMedia(REDUCED), window.matchMedia(mobileQuery)];
      mqs.forEach(m => m.addEventListener('change', notify));
      const conn = connection();
      conn?.addEventListener?.('change', notify);
      return () => {
        mqs.forEach(m => m.removeEventListener('change', notify));
        conn?.removeEventListener?.('change', notify);
      };
    },
    [mobileQuery]
  );
  const mode = useSyncExternalStore<Mode>(
    subscribe,
    () => readMode(mobileQuery),
    () => 'off'
  );

  const chosen = mode === 'mobile' ? srcMobile || src : src;
  // Remember WHICH url failed so swapping to another source gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const show = mode !== 'off' && !!chosen && failed !== chosen;
  // Rule (e) (W4): the looping video can be stopped.
  const [userPaused, setUserPaused] = useState(false);
  const t = useT();

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // React does not reflect `muted` as an attribute; autoplay needs it set.
    v.muted = true;
    if (!active || userPaused) {
      v.pause();
      return;
    }
    // Autoplay refused or the source is unplayable: keep the poster. An
    // AbortError only means a pause()/reload interrupted this play(), so ignore it.
    v.play().catch((e: unknown) => {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'NotSupportedError') setFailed(chosen);
    });
  }, [active, show, chosen, userPaused]);

  return (
    <>
      {children ??
        (poster ? (
          <img src={poster} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
        ) : null)}
      {show && (
        <video
          ref={ref}
          key={chosen}
          src={chosen}
          poster={children ? undefined : poster}
          muted
          loop
          playsInline
          // An inactive carousel slide must not start loading or playing; it
          // flips to autoplay/metadata when it becomes the active slide.
          autoPlay={active}
          preload={active ? 'metadata' : 'none'}
          disablePictureInPicture
          disableRemotePlayback
          aria-hidden="true"
          tabIndex={-1}
          onError={() => setFailed(chosen)}
          className={`pointer-events-none absolute inset-0 h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
          style={position ? { objectPosition: position } : undefined}
        />
      )}
      {show && active && (
        <AutoplayToggle
          paused={userPaused}
          onToggle={() => setUserPaused(p => !p)}
          labels={{
            pause: t('Pause video', 'إيقاف الفيديو'),
            play: t('Play video', 'تشغيل الفيديو'),
          }}
          className="absolute bottom-3 end-3"
        />
      )}
    </>
  );
}
