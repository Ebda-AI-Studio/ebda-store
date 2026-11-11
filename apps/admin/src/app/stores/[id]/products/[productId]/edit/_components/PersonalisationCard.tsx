'use client';

/**
 * PersonalisationCard: lets the customer type a per-item text on the PDP
 * ("Name to embroider"). Sits after FactsCard (storefront order: the field is
 * in the buy box, above add-to-cart).
 *
 * Controlled and presentational: it only edits the page's form state. The edit
 * page owns the single PUT (one writer) and turns this state into the API's
 * PersonalisationConfig via `personalisationPayload`.
 */

import { Input } from '@ebda/ui';
import { PERSONALISATION_NOTE_MAX, type PersonalisationConfig } from '@ebda/shared';
import { Toggle } from '@/components/Toggle';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';

import { Button } from '@/components/ui/Button';
export const PERSONALISATION_DEFAULT_MAX = 20;

export interface PersonalisationForm {
  enabled: boolean;
  label: string;
  labelAr: string;
  /** Raw input string; validated on save. */
  maxLength: string;
  required: boolean;
}

export const EMPTY_PERSONALISATION: PersonalisationForm = {
  enabled: false,
  label: '',
  labelAr: '',
  maxLength: String(PERSONALISATION_DEFAULT_MAX),
  required: false,
};

/** Stored config (or null) → form state. */
export function personalisationForm(raw: unknown): PersonalisationForm {
  if (!raw || typeof raw !== 'object') return EMPTY_PERSONALISATION;
  const c = raw as Partial<PersonalisationConfig>;
  return {
    enabled: c.enabled === true,
    label: typeof c.label === 'string' ? c.label : '',
    labelAr: typeof c.labelAr === 'string' ? c.labelAr : '',
    maxLength:
      typeof c.maxLength === 'number' ? String(c.maxLength) : String(PERSONALISATION_DEFAULT_MAX),
    required: c.required === true,
  };
}

/**
 * Form state → PUT value. `null` when it is off and nothing was typed (clears
 * the column); off-with-labels keeps the labels for re-enabling. Returns an
 * error key for the page's banner instead of sending something the API rejects.
 */
export function personalisationPayload(
  f: PersonalisationForm
): { value: PersonalisationConfig | null } | { error: 'needLabel' | 'invalidMax' } {
  const label = f.label.trim();
  const labelAr = f.labelAr.trim();
  if (!f.enabled && !label && !labelAr) return { value: null };
  const max = Number(f.maxLength.trim() || PERSONALISATION_DEFAULT_MAX);
  const maxValid = Number.isInteger(max) && max >= 1 && max <= PERSONALISATION_NOTE_MAX;
  // Off: the field is hidden, so a half-typed max length must not block the
  // product save. Keep the labels and fall back to the default.
  if (!f.enabled) {
    return {
      value: {
        enabled: false,
        label,
        labelAr,
        maxLength: maxValid ? max : PERSONALISATION_DEFAULT_MAX,
        required: f.required,
      },
    };
  }
  if (!maxValid) return { error: 'invalidMax' };
  if (f.enabled && !label && !labelAr) return { error: 'needLabel' };
  return { value: { enabled: f.enabled, label, labelAr, maxLength: max, required: f.required } };
}

const PRESETS = [
  { key: 'embroider', label: 'Name to embroider', labelAr: 'الاسم للتطريز' },
  { key: 'engrave', label: 'Letters to engrave', labelAr: 'الحروف للحفر' },
  { key: 'note', label: 'Note', labelAr: 'ملاحظة' },
] as const;

interface Props {
  value: PersonalisationForm;
  onChange: (next: PersonalisationForm) => void;
}

export function PersonalisationCard({ value, onChange }: Props) {
  const t = useT('products.edit.personalisation');
  const isAr = useLocale() === 'ar';
  const set = (patch: Partial<PersonalisationForm>) => onChange({ ...value, ...patch });

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>

      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-foreground">{t('allow')}</span>
        <Toggle checked={value.enabled} onChange={enabled => set({ enabled })} />
      </label>

      {value.enabled && (
        <div className="mt-5 space-y-4">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">{t('presets')}</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map(p => {
                const active = value.labelAr === p.labelAr && value.label === p.label;
                return (
                  <Button
                    key={p.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => set({ label: p.label, labelAr: p.labelAr })}
                    variant={active ? 'soft' : 'outline'}
                    size="sm"
                  >
                    {isAr ? p.labelAr : p.label}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t('labelAr')}
              value={value.labelAr}
              maxLength={60}
              onChange={e => set({ labelAr: e.target.value })}
              placeholder={t('embroideryNameArSample')}
              lang="ar"
              dir="rtl"
            />
            <Input
              label={t('labelEn')}
              value={value.label}
              maxLength={60}
              onChange={e => set({ label: e.target.value })}
              placeholder={t('embroideryNameEnSample')}
              lang="en"
              dir="ltr"
            />
          </div>

          <div className="flex flex-wrap items-end gap-6">
            <div className="w-40">
              <Input
                label={t('maxLength')}
                type="number"
                inputMode="numeric"
                min={1}
                max={PERSONALISATION_NOTE_MAX}
                step={1}
                value={value.maxLength}
                onChange={e => set({ maxLength: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={value.required}
                onChange={e => set({ required: e.target.checked })}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              {t('required')}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
