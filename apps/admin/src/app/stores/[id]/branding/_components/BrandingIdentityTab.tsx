'use client';

import { useT } from '@/i18n/useT';
import { LogoUploader } from './LogoUploader';
import type { StoreBranding } from './types';

interface BrandingIdentityTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Store identity tab: name (EN/AR), logos + favicon, and description (EN/AR).
 */
export function BrandingIdentityTab({ branding, onChange }: BrandingIdentityTabProps) {
  const t = useT('branding.identity');

  return (
    <div className="bg-card rounded-xl border p-6 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('storeName')}</label>
          <input
            type="text"
            value={branding.name}
            onChange={e => onChange({ ...branding, name: e.target.value })}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('storeNameAr')}
          </label>
          <input
            type="text"
            dir="rtl"
            value={branding.nameAr || ''}
            onChange={e => onChange({ ...branding, nameAr: e.target.value })}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
      </div>

      <LogoUploader branding={branding} onChange={onChange} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('description')}
          </label>
          <textarea
            value={branding.description || ''}
            onChange={e => onChange({ ...branding, description: e.target.value })}
            rows={3}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('descriptionAr')}
          </label>
          <textarea
            dir="rtl"
            value={branding.descriptionAr || ''}
            onChange={e => onChange({ ...branding, descriptionAr: e.target.value })}
            rows={3}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
          />
        </div>
      </div>
    </div>
  );
}
