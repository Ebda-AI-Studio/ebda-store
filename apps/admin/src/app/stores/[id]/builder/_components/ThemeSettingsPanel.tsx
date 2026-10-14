'use client';

/**
 * Global theme settings (Shopify `settings_schema`): colours, typography,
 * buttons, spacing — generated from `THEME_SETTINGS_SCHEMA`. Saving writes ONLY
 * the keys this panel changed into the page DRAFT (`PageDefinition.theme`, via
 * `onSave`); nothing reaches the live store theme until Publish promotes the
 * draft (Ruling THEME-DRAFT-1). `theme` is the effective theme: live + draft.
 * Theme colours are stored as HSL triplets; the colour field speaks hex.
 */
import { useState } from 'react';
import { useLocale } from 'next-intl';
import {
  DEFAULT_THEME,
  THEME_SETTINGS_SCHEMA,
  hexToHsl,
  hslToHex,
  overriddenLookKeys,
  type LookDefinition,
  type StoreTheme,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { ColorField } from '../../../../../components/ColorField';
import { Toggle } from '../../../../../components/Toggle';
import { apiPut } from '../../../../../lib/api';

export function ThemeSettingsPanel({
  theme,
  onSave,
  storeId,
  look = null,
  onThemeReset,
  liveTheme,
  flushDraft,
  removeDraftKey,
}: {
  theme: StoreTheme | undefined;
  storeId?: string;
  /** The store's look; null/absent = legacy skin, no override tracking. */
  look?: LookDefinition | null;
  /** Called after a single override was reset, so the caller re-reads the live theme. */
  onThemeReset?: () => void;
  /** The LIVE store theme (without the draft patch): decides whether a live PUT is needed. */
  liveTheme?: Record<string, unknown> | null;
  /** Resolves true once every pending/in-flight draft save has landed. */
  flushDraft?: () => Promise<boolean>;
  /** Omits the key from the draft document's theme and saves the draft; true when saved. */
  removeDraftKey?: (key: string) => Promise<boolean>;
  /** Writes the patch into the draft and resolves true once the draft is saved. */
  onSave: (patch: Partial<StoreTheme>) => Promise<boolean>;
}) {
  const t = useT('builder.theme');
  const locale = useLocale();
  const [patch, setPatch] = useState<Partial<StoreTheme>>({});
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const current = { ...(theme ?? DEFAULT_THEME), ...patch } as Record<string, unknown>;
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetFailed, setResetFailed] = useState(false);
  const overridden = new Set<string>(
    look && theme ? overriddenLookKeys(theme as unknown as Record<string, unknown>, look) : []
  );
  // This panel is the single writer of a reset, draft first: (1) flush any pending or in-flight
  // draft save so it cannot re-introduce the key, (2) omit the key from the draft theme, (3) only
  // if the LIVE theme holds it, PUT null (deletes the stored key), (4) let the caller re-read both.
  const resetOne = async (key: string) => {
    if (!storeId) return;
    setResetting(key);
    setResetFailed(false);
    try {
      if (flushDraft && !(await flushDraft())) return setResetFailed(true);
      if (removeDraftKey && !(await removeDraftKey(key))) return setResetFailed(true);
      if (!liveTheme || liveTheme[key] !== undefined) {
        const { error } = await apiPut(`/api/v1/stores/${storeId}/theme`, { [key]: null });
        if (error) return setResetFailed(true);
      }
      setPatch(p => {
        const rest = { ...p };
        delete rest[key as keyof StoreTheme];
        return rest;
      });
      onThemeReset?.();
    } catch {
      setResetFailed(true);
    } finally {
      setResetting(null);
    }
  };
  const set = (key: keyof StoreTheme, value: unknown) => {
    setPatch(p => ({ ...p, [key]: value }));
    setState('idle');
  };
  const save = async () => {
    setState('saving');
    const ok = await onSave(patch);
    if (!ok) return setState('error');
    setPatch({});
    setState('saved');
  };

  const renderField = (s: (typeof THEME_SETTINGS_SCHEMA)[number]['settings'][number]) => {
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
  };

  return (
    <div className="flex h-full flex-col" data-testid="theme-settings">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {THEME_SETTINGS_SCHEMA.map(group => (
          <fieldset key={group.id} className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {locale === 'ar' ? group.labelAr : group.labelEn}
            </legend>
            {group.settings.map(s => (
              <div key={s.id} className="space-y-1">
                {renderField(s)}
                {overridden.has(String(s.id)) && (
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                      {t('edited')}
                    </span>
                    <button
                      type="button"
                      disabled={resetting !== null}
                      aria-label={t('resetOne', {
                        field: locale === 'ar' ? s.labelAr : s.labelEn,
                      })}
                      onClick={() => void resetOne(String(s.id))}
                      className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-primary-ink underline disabled:opacity-40"
                    >
                      {t('reset')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border p-3">
        <span role="status" className="text-xs text-muted-foreground">
          {resetFailed
            ? t('resetError')
            : state === 'saved'
              ? t('saved')
              : state === 'error'
                ? t('error')
                : ''}
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
