'use client';

import { Button } from '@/components/ui/Button';
import { useMemo } from 'react';
import { useT } from '@/i18n/useT';
import { SOCIAL_PLATFORMS, type StoreBranding } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface SocialLinksTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Platform keys that can appear in the storefront footer (subset of
 * SOCIAL_PLATFORMS + whatsapp which comes from contact info, not socialLinks).
 * wikidata / wikipedia are social-links fields but are NOT rendered as footer
 * icons so they are excluded from the order control.
 */
const FOOTER_ELIGIBLE_KEYS = [
  'instagram',
  'facebook',
  'twitter',
  'tiktok',
  'youtube',
  'snapchat',
  'linkedin',
  'whatsapp',
] as const;

type FooterEligibleKey = (typeof FOOTER_ELIGIBLE_KEYS)[number];

/** Display name for each key shown in the order list. */
const PLATFORM_LABELS: Record<FooterEligibleKey, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  twitter: 'Twitter / X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  snapchat: 'Snapchat',
  linkedin: 'LinkedIn',
  whatsapp: 'WhatsApp',
};

/**
 * Social links tab: one input per supported platform + a reorder control
 * for platforms that have a URL (controls display order in storefront footer).
 */
export function SocialLinksTab({ branding, onChange }: SocialLinksTabProps) {
  const t = useT('branding.social');
  const tOrder = useT('branding.social.order');

  // Build the list of footer-eligible platforms that currently have a URL.
  const activePlatforms = useMemo<FooterEligibleKey[]>(() => {
    const result: FooterEligibleKey[] = [];
    for (const key of FOOTER_ELIGIBLE_KEYS) {
      if (key === 'whatsapp') {
        if (branding.whatsapp?.trim()) result.push(key);
      } else {
        if ((branding.socialLinks as Record<string, string | undefined>)[key]?.trim()) {
          result.push(key);
        }
      }
    }
    return result;
  }, [branding.socialLinks, branding.whatsapp]);

  // Apply the saved order (from theme.socialOrder) to the active list.
  const orderedPlatforms = useMemo<FooterEligibleKey[]>(() => {
    const saved = branding.theme.socialOrder;
    if (!saved || saved.length === 0) return activePlatforms;
    const rankMap = new Map(saved.map((k, i) => [k, i]));
    return [...activePlatforms].sort(
      (a, b) => (rankMap.get(a) ?? Infinity) - (rankMap.get(b) ?? Infinity)
    );
  }, [activePlatforms, branding.theme.socialOrder]);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= orderedPlatforms.length) return;
    const next = [...orderedPlatforms];
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    onChange({
      ...branding,
      theme: { ...branding.theme, socialOrder: next },
    });
  }

  return (
    <div className="space-y-6">
      {/* URL inputs — one per SOCIAL_PLATFORMS entry */}
      <div className="bg-card rounded-xl border p-6 space-y-6">
        {SOCIAL_PLATFORMS.map(social => (
          <div key={social.key}>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t(social.labelKey)}
            </label>
            <input
              type="url"
              value={(branding.socialLinks as Record<string, string>)[social.key] || ''}
              onChange={e =>
                onChange({
                  ...branding,
                  socialLinks: { ...branding.socialLinks, [social.key]: e.target.value },
                })
              }
              placeholder={social.placeholder}
              className={FIELD_CLASSES}
            />
          </div>
        ))}
      </div>

      {/* Reorder control — shows only platforms that have a URL */}
      <div className="bg-card rounded-xl border p-6">
        <h3 className="text-sm font-semibold text-foreground mb-1">{tOrder('title')}</h3>
        <p className="text-xs text-muted-foreground mb-4">{tOrder('hint')}</p>

        {orderedPlatforms.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">{tOrder('empty')}</p>
        ) : (
          <ul className="space-y-2">
            {orderedPlatforms.map((key, index) => (
              <li
                key={key}
                className="flex items-center gap-3 px-3 py-2 bg-muted/40 rounded-lg border border-border"
              >
                {/* Drag handle (visual only) */}
                <span className="text-muted-foreground select-none" aria-hidden="true">
                  ⠿
                </span>

                <span className="flex-1 text-sm font-medium text-foreground">
                  {PLATFORM_LABELS[key]}
                </span>

                <div className="flex gap-1" role="group" aria-label={PLATFORM_LABELS[key]}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={tOrder('moveUp')}
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-4 w-4"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 3a.75.75 0 01.53.22l5 5a.75.75 0 01-1.06 1.06L10 4.81 5.53 9.28a.75.75 0 01-1.06-1.06l5-5A.75.75 0 0110 3z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === orderedPlatforms.length - 1}
                    aria-label={tOrder('moveDown')}
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-4 w-4"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 17a.75.75 0 01-.53-.22l-5-5a.75.75 0 011.06-1.06L10 15.19l4.47-4.47a.75.75 0 011.06 1.06l-5 5A.75.75 0 0110 17z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
