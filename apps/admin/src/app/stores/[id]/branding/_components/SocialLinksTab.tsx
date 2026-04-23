'use client';

import { useT } from '@/i18n/useT';
import { SOCIAL_PLATFORMS, type StoreBranding } from './types';

interface SocialLinksTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Social links tab: one input per supported platform.
 */
export function SocialLinksTab({ branding, onChange }: SocialLinksTabProps) {
  const t = useT('branding.social');

  return (
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
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
      ))}
    </div>
  );
}
