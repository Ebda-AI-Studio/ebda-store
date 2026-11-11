'use client';

import { hasWaMeNumber, normalizeEgyptianMobile } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import type { StoreBranding } from './types';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

interface ContactInfoTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Contact tab: email, WhatsApp, phone (EN/AR), and address (EN/AR).
 */
export function ContactInfoTab({ branding, onChange }: ContactInfoTabProps) {
  const t = useT('branding.contact');
  const waValue = branding.whatsapp?.trim() ?? '';
  const waInvalid = waValue !== '' && normalizeEgyptianMobile(waValue) === null;
  const waReady = hasWaMeNumber(waValue);
  const toggles = [
    ['waMeProductShare', 'waMeProductShare', 'waMeProductShareHint'],
    ['waMeOrderQuestion', 'waMeOrderQuestion', 'waMeOrderQuestionHint'],
    ['waMeCodConfirm', 'waMeCodConfirm', 'waMeCodConfirmHint'],
  ] as const;

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
            className={FIELD_CLASSES}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('whatsapp')}</label>
          <input
            type="tel"
            value={branding.whatsapp || ''}
            onChange={e => onChange({ ...branding, whatsapp: e.target.value })}
            placeholder={t('phonePlaceholder')}
            aria-invalid={waInvalid}
            dir="ltr"
            className={FIELD_CLASSES}
          />
          <p
            className={`mt-1 text-xs ${waInvalid ? 'text-destructive-ink' : 'text-muted-foreground'}`}
            role={waInvalid ? 'alert' : undefined}
          >
            {waInvalid ? t('whatsappInvalid') : t('whatsappHint')}
          </p>
        </div>
      </div>

      <fieldset className="space-y-3 rounded-xl border p-4" data-testid="wa-me-toggles">
        <legend
          data-setting-id="branding.whatsapp-buttons"
          className="px-1 text-sm font-semibold text-foreground"
        >
          {t('waMeTitle')}
        </legend>
        {!waReady && <p className="text-xs text-muted-foreground">{t('waMeNeedsNumber')}</p>}
        {toggles.map(([key, label, hint]) => (
          <label key={key} className="flex cursor-pointer items-center justify-between gap-4">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{t(label)}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t(hint)}</span>
            </span>
            <input
              type="checkbox"
              disabled={!waReady}
              checked={waReady && branding.theme[key] !== false}
              onChange={e =>
                onChange({ ...branding, theme: { ...branding.theme, [key]: e.target.checked } })
              }
              aria-label={t(label)}
              className="h-5 w-5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        ))}
      </fieldset>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('phone')}</label>
          <input
            type="tel"
            value={branding.phone || ''}
            onChange={e => onChange({ ...branding, phone: e.target.value })}
            placeholder={t('phonePlaceholder')}
            className={FIELD_CLASSES}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('phoneAr')}</label>
          <input
            type="text"
            lang="ar"
            dir="rtl"
            value={branding.phoneAr || ''}
            onChange={e => onChange({ ...branding, phoneAr: e.target.value })}
            placeholder={t('phoneArPlaceholder')}
            className={FIELD_CLASSES}
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
            className={`${TEXTAREA_CLASSES} resize-none`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('addressAr')}</label>
          <textarea
            lang="ar"
            dir="rtl"
            value={branding.addressAr || ''}
            onChange={e => onChange({ ...branding, addressAr: e.target.value })}
            rows={3}
            placeholder={t('addressArPlaceholder')}
            className={`${TEXTAREA_CLASSES} resize-none`}
          />
        </div>
      </div>

      {/*
        Map link: paste a Google / Apple Maps URL the storefront footer
        should hyperlink the address to. Paired with a "Make address
        clickable" toggle so a tenant can opt out of the link entirely
        without clearing their pasted URL. When the URL is empty and the
        toggle is on, the storefront still falls back to a Google-Maps
        search built from the address text — preserving long-standing
        behaviour for stores that haven't pasted a custom pin yet.
      */}
      <div className="border-t border-border/60 pt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('addressUrl')}
          </label>
          <input
            type="url"
            value={branding.addressUrl || ''}
            onChange={e => onChange({ ...branding, addressUrl: e.target.value })}
            placeholder={t('addressUrlPlaceholder')}
            className={FIELD_CLASSES}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('addressUrlHint')}</p>
        </div>
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={branding.addressLink !== false}
            onChange={e => onChange({ ...branding, addressLink: e.target.checked })}
            className="h-4 w-4 rounded border-input text-primary focus:ring-primary/40"
          />
          <span className="text-sm text-foreground">{t('addressClickable')}</span>
        </label>
      </div>
    </div>
  );
}
