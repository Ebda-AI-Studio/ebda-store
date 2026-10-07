'use client';

/**
 * Global theme settings (Shopify `settings_schema`): colours, typography,
 * buttons, spacing — generated from `THEME_SETTINGS_SCHEMA`. These live on
 * the store theme, whose single writer is the theme PUT (a server-side
 * shallow-merge PATCH): we send ONLY the keys this panel changed.
 * Theme colours are stored as HSL triplets; the colour field speaks hex.
 */
import { useState } from 'react';
import { useLocale } from 'next-intl';
import {
  DEFAULT_THEME,
  THEME_SETTINGS_SCHEMA,
  hexToHsl,
  hslToHex,
  type StoreTheme,
} from '@force/shared';
import { useT } from '@/i18n/useT';
import { ColorField } from '../../../../../components/ColorField';
import { Toggle } from '../../../../../components/Toggle';
import { apiPut } from '../../../../../lib/api';

export function ThemeSettingsPanel({
  storeId,
  theme,
  onSaved,
}: {
  storeId: string;
  theme: StoreTheme | undefined;
  onSaved: (patch: Partial<StoreTheme>) => void;
}) {
  const t = useT('builder.theme');
  const locale = useLocale();
  const [patch, setPatch] = useState<Partial<StoreTheme>>({});
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const current = { ...(theme ?? DEFAULT_THEME), ...patch } as Record<string, unknown>;
  const set = (key: keyof StoreTheme, value: unknown) => {
    setPatch(p => ({ ...p, [key]: value }));
    setState('idle');
  };
  const save = async () => {
    setState('saving');
    const res = await apiPut(`/api/v1/stores/${storeId}/theme`, patch);
    if (res.error) return setState('error');
    onSaved(patch);
    setPatch({});
    setState('saved');
  };

  return (
    <div className="flex h-full flex-col" data-testid="theme-settings">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {THEME_SETTINGS_SCHEMA.map(group => (
          <fieldset key={group.id} className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {locale === 'ar' ? group.labelAr : group.labelEn}
            </legend>
            {group.settings.map(s => {
              const label = locale === 'ar' ? s.labelAr : s.labelEn;
              const v = current[s.id];
              if (s.type === 'color') {
                const hex = typeof v === 'string' && v.trim() ? hslToHex(v) : undefined;
                return (
                  <ColorField
                    key={s.id}
                    label={label}
                    value={hex}
                    theme={theme ?? DEFAULT_THEME}
                    showContrastPreview={false}
                    onChange={next => {
                      // tokens make no sense for the token SOURCES themselves
                      if (/^#[0-9a-f]{3,8}$/i.test(next)) set(s.id, hexToHsl(next));
                    }}
                  />
                );
              }
              if (s.type === 'select')
                return (
                  <label key={s.id} className="block text-sm">
                    <span className="mb-1 block text-xs font-semibold">{label}</span>
                    <select
                      value={typeof v === 'string' ? v : ''}
                      onChange={e => set(s.id, e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
                    >
                      {s.options?.map(o => (
                        <option key={String(o.value)} value={String(o.value)}>
                          {locale === 'ar' ? o.labelAr : o.labelEn}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              if (s.type === 'checkbox')
                return (
                  <label key={s.id} className="flex items-center justify-between text-sm">
                    <span>{label}</span>
                    <Toggle checked={v === true} onChange={on => set(s.id, on)} />
                  </label>
                );
              if (s.type === 'text')
                return (
                  <label key={s.id} className="block text-sm">
                    <span className="mb-1 block text-xs font-semibold">{label}</span>
                    <input
                      dir="ltr"
                      value={typeof v === 'string' ? v : ''}
                      onChange={e => set(s.id, e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
                    />
                  </label>
                );
              return (
                <p key={s.id} className="text-xs text-muted-foreground">
                  {label} · {t('classicOnly')}
                </p>
              );
            })}
          </fieldset>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border p-3">
        <span role="status" className="text-xs text-muted-foreground">
          {state === 'saved' ? t('saved') : state === 'error' ? t('error') : ''}
        </span>
        <button
          type="button"
          disabled={Object.keys(patch).length === 0 || state === 'saving'}
          onClick={() => void save()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {state === 'saving' ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
}
