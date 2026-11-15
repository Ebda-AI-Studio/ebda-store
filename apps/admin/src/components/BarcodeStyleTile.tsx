'use client';

import { useMemo, type ReactNode } from 'react';
import { renderBarcodeSvg } from '@ebda/shared';

/**
 * The ONE tile every barcode-style picker uses (labels tab, receipt tab). Every tile has the same
 * box in every state: selected / hover / focus change colour and a ring (box-shadow), never
 * border width, padding or size. The art sits in a fixed-height clipped box and the SVG scales
 * to fit it (viewBox "meet"), so a wide Plain-bars SVG can never spill out of its tile, and the
 * grid uses minmax(0,1fr) columns so no child can widen a track.
 */
const TILE_LAYOUT =
  'relative flex min-w-0 flex-col items-center gap-1 rounded-lg border p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
const TILE_STATE = {
  on: 'border-primary bg-primary/10 text-foreground ring-2 ring-primary/40',
  off: 'border-border bg-background text-muted-foreground hover:bg-muted',
  blocked: 'cursor-not-allowed border-border bg-muted/40 text-muted-foreground opacity-50',
} as const;
const ART_BOX = 'flex h-14 w-full min-w-0 items-center justify-center overflow-hidden';
const ART_SVG = 'block h-full w-full text-foreground [&>svg]:h-full [&>svg]:w-full';

export function BarcodeStyleGrid({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2 p-1 sm:grid-cols-[repeat(4,minmax(0,1fr))] ${className}`}
    >
      {children}
    </div>
  );
}

/** A real, scannable Code 128 of `sample` drawn in `shape`, clipped to its box. */
function BarcodeArt({ shape, sample }: { shape: string; sample: string }) {
  const svg = useMemo(
    () => renderBarcodeSvg({ value: sample, shape, label: false }),
    [shape, sample]
  );
  return (
    <bdi dir="ltr" className="block h-full w-full">
      <span
        aria-hidden="true"
        className={ART_SVG}
        // Built by our own encoder from a constant; nothing user-supplied.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </bdi>
  );
}

/** "No barcode": a crossed-out barcode, decorative (the tile's text label names it). */
function NoBarcodeGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 64 40"
      className="h-full w-full text-muted-foreground"
      fill="none"
    >
      <g fill="currentColor" opacity="0.55">
        <rect x="12" y="6" width="3" height="28" />
        <rect x="18" y="6" width="1.5" height="28" />
        <rect x="22" y="6" width="4" height="28" />
        <rect x="29" y="6" width="2" height="28" />
        <rect x="34" y="6" width="3" height="28" />
        <rect x="40" y="6" width="1.5" height="28" />
        <rect x="44" y="6" width="4" height="28" />
        <rect x="50" y="6" width="2" height="28" />
      </g>
      <line
        x1="8"
        y1="36"
        x2="56"
        y2="4"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BarcodeStyleTile({
  id,
  name,
  sample,
  selected,
  blockedReason,
  onSelect,
}: {
  /** A shape id, `plain`, or `off` (No barcode). */
  id: string;
  name: string;
  sample: string;
  selected: boolean;
  /** Set when this style cannot print here: the tile greys out and explains why. */
  blockedReason?: string;
  onSelect: () => void;
}) {
  const blocked = !!blockedReason && !selected;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={blocked ? true : undefined}
      title={blockedReason}
      aria-label={blockedReason ? `${name}. ${blockedReason}` : name}
      onClick={() => {
        if (!blocked) onSelect();
      }}
      className={`${TILE_LAYOUT} ${selected ? TILE_STATE.on : blockedReason ? TILE_STATE.blocked : TILE_STATE.off}`}
    >
      <span className={ART_BOX}>
        {id === 'off' ? <NoBarcodeGlyph /> : <BarcodeArt shape={id} sample={sample} />}
      </span>
      <span className="w-full truncate text-center font-medium">{name}</span>
    </button>
  );
}
