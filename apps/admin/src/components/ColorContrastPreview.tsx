'use client';

import { resolveColor, pickReadableForeground, contrastRatio } from '@ebda/shared';
import type { StoreTheme } from '@ebda/shared';
import { useT } from '@/i18n/useT';

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
  const t = useT('components.colorContrastPreview');
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

  const roles = [t('roles.heading'), t('roles.subtitle'), t('roles.bodyCta')];

  return (
    <div className="mt-2 rounded-lg border border-border p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-foreground">
          {t('backgroundLabel', { label: displayLabel })}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{resolved}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {roles.map(role => (
          <div
            key={role}
            className="rounded p-2 text-center"
            style={{ backgroundColor: resolved, color: autoFg }}
          >
            {role}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {/* i18n-gate-allow: standard name */}
          {t('autoFixedLabel')} <span className="font-mono">{autoFg}</span> · WCAG{' '}
          {autoRatio.toFixed(1)} : 1{' '}
          {autoRatio >= HEADING_AA_MIN ? '✓' : autoRatio >= LARGE_AA_MIN ? '⚠' : '✗'}
        </span>
        {warn && merchantRatio !== null ? (
          <span className="text-warning-ink">
            ⚠{' '}
            {t('pickedTextWarning', {
              ratio: merchantRatio.toFixed(1),
              min: HEADING_AA_MIN,
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
