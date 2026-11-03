'use client';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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
  // PREMIUM-30: the Latin line may never end in an ellipsis. It is measured; when the slot cannot hold the
  // whole word it is dropped (collapsed, still measured so it returns when the slot widens).
  const latinRef = useRef<HTMLSpanElement>(null);
  const [latinFits, setLatinFits] = useState(true);
  useLayoutEffect(() => {
    const el = latinRef.current;
    if (!el) return;
    const measure = () => setLatinFits(el.scrollWidth <= el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [latin]);
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
    // `line-clamp` clips at its padding box: a 1.4 line plus 0.3em padding (cancelled by a negative margin, so the
    // layout does not move) keeps the dots whole (Qamar lookbook's name was still cut at the page top, PREMIUM-30).
    lineHeight: 1.4,
    paddingBlock: '0.3em',
    marginBlock: '-0.3em',
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
    // the tracking adds trailing space after the last letter: balance it with the same space at the start so the
    // line stays optically centred WITHOUT shrinking the box (a negative end margin made the box 4px narrower than
    // the word, which is what produced the ellipsis, PREMIUM-30)
    paddingInlineStart: `${lockup.latinTracking}em`,
    // a dropped line collapses; it stays in the flow so it can be measured again
    ...(latinFits ? null : { height: 0, opacity: 0, marginBlockStart: stack ? -4 : 0 }),
  };
  return (
    <span
      // an inline lockup stacks on a phone: the 134 px slot cannot hold the name and the Latin word side by side
      className={`inline-flex max-w-full items-center justify-center ${stack ? 'flex-col gap-1' : 'flex-col gap-1 md:flex-row md:gap-2.5'}`}
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
          ref={latinRef}
          aria-hidden="true"
          // PREMIUM-10: the Latin line is LTR text inside an RTL header; without dir=ltr the
          // ellipsis landed at the START ("…MAR"). dir=ltr truncates at the end and keeps the word whole.
          dir="ltr"
          // lang=en keeps the Latin word's own tracking: the Arabic-page reset (`:lang(ar) *`) is for Arabic joining
          lang="en"
          className="block max-w-full overflow-hidden whitespace-nowrap uppercase"
          style={latinStyle}
        >
          {latin}
        </span>
      )}
    </span>
  );
}
