'use client';

import { resolveColor, pickReadableForeground, contrastRatio } from '@force/shared';
import type { StoreTheme } from '@force/shared';

interface ColorContrastPreviewProps {
  /** Current ColorField value — hex, 'token:<name>', or empty. */
  bg: string | undefined;
  /** Store theme to resolve tokens against. */
  theme: StoreTheme;
  /** Optional merchant-picked foreground from the corresponding typography zone. */
  pickedFg?: string;
}

const HEADING_AA_MIN = 4.5; // WCAG AA normal text
const LARGE_AA_MIN = 3.0; // WCAG AA large text

export function ColorContrastPreview({ bg, theme, pickedFg }: ColorContrastPreviewProps) {
  const resolved = resolveColor(bg, theme);
  if (!resolved) return null;

  const autoFg = pickReadableForeground(resolved) ?? '#000000';
  const tokenName = bg?.startsWith('token:') ? bg.slice(6) : null;
  const displayLabel = tokenName
    ? `${tokenName.charAt(0).toUpperCase() + tokenName.slice(1)} (${resolved})`
    : resolved;

  const merchantRatio = pickedFg ? contrastRatio(resolved, pickedFg) : null;
  const autoRatio = contrastRatio(resolved, autoFg);

  const warn = merchantRatio !== null && merchantRatio < HEADING_AA_MIN;

  return (
    <div className="mt-2 rounded-lg border border-border p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-foreground">Background: {displayLabel}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{resolved}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(['Heading', 'Subtitle', 'Body / CTA'] as const).map(role => (
          <div
            key={role}
            className="rounded p-2 text-center"
            style={{ backgroundColor: resolved, color: autoFg }}
          >
            {role}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">
          Auto-fixed: <span className="font-mono">{autoFg}</span> · WCAG {autoRatio.toFixed(1)} : 1{' '}
          {autoRatio >= HEADING_AA_MIN ? '✓' : autoRatio >= LARGE_AA_MIN ? '⚠' : '✗'}
        </span>
        {warn && merchantRatio !== null ? (
          <span className="text-amber-600">
            ⚠ Picked text {merchantRatio.toFixed(1)} : 1 — AA needs {HEADING_AA_MIN} : 1
          </span>
        ) : null}
      </div>
    </div>
  );
}
