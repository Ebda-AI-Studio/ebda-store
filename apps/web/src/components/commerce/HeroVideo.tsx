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

export interface HeroVideoProps {
  src: string;
  /** Used instead of `src` at or below `mobileQuery`. */
  srcMobile?: string;
  /** Poster image URL, used only when no `children` are given: it is then both the base <img> and the video's poster. With children, the children ARE the poster and the video stays transparent until its first frame. */
  poster?: string;
  alt?: string;
  /** Extra classes for the <video> (e.g. `object-contain` for a framed hero). */
  className?: string;
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
  className = '',
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

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // React does not reflect `muted` as an attribute; autoplay needs it set.
    v.muted = true;
    if (!active) {
      v.pause();
      return;
    }
    // Autoplay refused (data saver, low-power mode): keep the poster.
    v.play().catch(() => setFailed(chosen));
  }, [active, show, chosen]);

  return (
    <>
      {children ??
        (poster ? (
          // eslint-disable-next-line @next/next/no-img-element
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
          autoPlay
          preload="metadata"
          disablePictureInPicture
          disableRemotePlayback
          aria-hidden="true"
          tabIndex={-1}
          onError={() => setFailed(chosen)}
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover ${className}`.trim()}
        />
      )}
    </>
  );
}
