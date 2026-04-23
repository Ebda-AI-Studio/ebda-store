'use client';

import { useT } from '@/i18n/useT';
import type { StoreBranding } from './types';

interface ContactInfoTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Contact tab: email, WhatsApp, phone (EN/AR), and address (EN/AR).
 */
export function ContactInfoTab({ branding, onChange }: ContactInfoTabProps) {
  const t = useT('branding.contact');

  return (
    <div className="bg-card rounded-xl border p-6 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('email')}</label>
          <input
            type="email"
            value={branding.email || ''}
            onChange={e => onChange({ ...branding, email: e.target.value })}
            placeholder={t('emailPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('whatsapp')}</label>
          <input
            type="tel"
            value={branding.whatsapp || ''}
            onChange={e => onChange({ ...branding, whatsapp: e.target.value })}
            placeholder={t('phonePlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('phone')}</label>
          <input
            type="tel"
            value={branding.phone || ''}
            onChange={e => onChange({ ...branding, phone: e.target.value })}
            placeholder={t('phonePlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('phoneAr')}</label>
          <input
            type="text"
            dir="rtl"
            value={branding.phoneAr || ''}
            onChange={e => onChange({ ...branding, phoneAr: e.target.value })}
            placeholder={t('phoneArPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('address')}</label>
          <textarea
            value={branding.address || ''}
            onChange={e => onChange({ ...branding, address: e.target.value })}
            rows={3}
            placeholder={t('addressPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('addressAr')}</label>
          <textarea
            dir="rtl"
            value={branding.addressAr || ''}
            onChange={e => onChange({ ...branding, addressAr: e.target.value })}
            rows={3}
            placeholder={t('addressArPlaceholder')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
          />
        </div>
      </div>
    </div>
  );
}
