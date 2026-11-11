'use client';

import { useEffect, useState } from 'react';
import { NileNight } from './NileNight';

/**
 * Tablet portrait and up: the Nile panel sits BESIDE the white sign-in form. Measured 2026-11-10 at
 * 600/768/820/1024: below 768 the panel would be a sliver next to a 384px form, so phones get the form
 * alone. Below this width NileNight is not mounted at all (no canvas, no animation loop), not just hidden.
 */
export const NILE_PANEL_MIN_WIDTH = 768;
const QUERY = `(min-width: ${NILE_PANEL_MIN_WIDTH}px)`;

function useWideEnoughForNile(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    setWide(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return wide;
}

export function NileSidePanel({ title, subtitle }: { title: string; subtitle: string }) {
  const wide = useWideEnoughForNile();
  return (
    <div data-testid="nile-side-panel" className="relative hidden w-0 flex-1 md:block">
      <div className="absolute inset-0 bg-[#0A0B0C]">
        {wide && <NileNight />}
        <div className="absolute inset-0 bg-[#0A0B0C]/55" aria-hidden="true" />
        <div className="relative flex h-full flex-col items-center justify-center px-8 text-white lg:px-12">
          <p className="text-center text-3xl font-bold lg:text-4xl">{title}</p>
          <p className="mt-4 max-w-md text-center text-base text-white/85 lg:text-lg">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}
