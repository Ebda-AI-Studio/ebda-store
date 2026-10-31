import type { CSSProperties } from 'react';
import { lockupLatin, type Lockup } from '@ebda/shared';

const COLOR: Record<'ink' | 'muted' | 'primary' | 'accent', string> = {
  ink: 'hsl(var(--foreground))',
  // not --muted-foreground: on Qamar lookbook that token is the dark ground's light grey and the PLP header
  // is light (1.57:1 measured); the ink at 70% keeps >= 4.5:1 on either ground
  muted: 'hsl(var(--foreground) / 0.7)',
  primary: 'hsl(var(--primary))',
  accent: 'hsl(var(--accent))',
};

const FACE: Record<Lockup['latinFace'], string> = {
  latin: 'var(--font-latin, var(--font-display))',
  display: 'var(--font-display)',
  body: 'var(--font-body)',
};

/**
 * The built-in typographic lockup for a store with no uploaded logo (packages/shared looks/lockup.ts):
 * the Arabic name in the look's display face with a letter-spaced Latin line under or beside it, as the
 * home-page mock-ups set it. Rendered by the header only when `branding.logo` is empty, so a merchant
 * logo always wins. Sizes are the mock-ups' own px values (a logo-like element, not body type).
 */
export function StoreLockup({
  lockup,
  name,
  nameAr,
  isRtl,
}: {
  lockup: Lockup;
  name: string;
  nameAr?: string | null;
  isRtl: boolean;
}) {
  const main = isRtl && nameAr ? nameAr : name;
  // the Latin line only accompanies an Arabic name (in English the name IS the Latin form)
  const latin = isRtl && nameAr ? lockupLatin(lockup, name) : null;
  const stack = lockup.layout === 'stack';
  // On a phone the logo may use about 134 px (the bar keeps room for cart and language on one side), so a
  // long name steps its display size down instead of wrapping into a column that hangs out of the bar.
  const phoneSize = Math.max(
    18,
    Math.min(lockup.size, Math.floor(134 / (Math.max(main.length, 1) * 0.75)))
  );
  const mainStyle: CSSProperties = {
    ['--ls' as string]: `${phoneSize}px`,
    fontSize: lockup.size,
    fontFamily: 'var(--font-display)',
    fontWeight: lockup.weight,
    // The display faces (Lalezar, Reem Kufi...) draw Arabic marks well above and below a 1.1 line box and
    // `line-clamp` clips at it: a 1.4 line keeps them whole (Qamar lookbook's name was cut at the page top).
    lineHeight: 1.4,
    color: COLOR[lockup.color],
    letterSpacing: 'normal',
  };
  const latinStyle: CSSProperties = {
    fontFamily: FACE[lockup.latinFace],
    fontSize: lockup.latinSize,
    fontWeight: lockup.latinWeight,
    letterSpacing: `${lockup.latinTracking}em`,
    lineHeight: 1,
    color: lockup.latinColor === 'none' ? undefined : COLOR[lockup.latinColor],
    // the tracking adds trailing space after the last letter: pull it back so the line stays optically centred
    marginInlineEnd: stack ? `calc(${lockup.latinTracking}em * -1)` : undefined,
  };
  return (
    <span
      className={`inline-flex max-w-full items-center justify-center ${stack ? 'flex-col gap-1' : 'flex-row gap-2.5'}`}
      data-zone="storeName"
      data-lockup={lockup.layout}
      translate="no"
      title={main}
    >
      <span
        className="block max-w-full line-clamp-2 [text-wrap:balance] max-md:![font-size:var(--ls)]"
        style={mainStyle}
      >
        {main}
      </span>
      {latin && (
        <span
          aria-hidden="true"
          className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap uppercase"
          style={latinStyle}
        >
          {latin}
        </span>
      )}
    </span>
  );
}
