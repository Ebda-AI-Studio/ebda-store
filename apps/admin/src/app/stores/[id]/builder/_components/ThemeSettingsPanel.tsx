'use client';

/**
 * Global theme settings (Shopify `settings_schema`): colours, typography,
 * buttons, spacing — generated from `THEME_SETTINGS_SCHEMA` — plus the font
 * library, the global typography zones and Smart Palette. Everything here is a
 * DRAFT edit (Rulings THEME-DRAFT-1 and VE-4): saving writes ONLY the keys this
 * panel changed into the page draft (`PageDefinition.theme`, via `onSave`);
 * fonts and zones go to `PageDefinition.typography`; resetting a key to the
 * look's default writes a `null` into the draft. Nothing reaches the live store
 * until Publish promotes the draft. `theme` is the effective theme: live + draft.
 * Theme colours are stored as HSL triplets; the colour field speaks hex.
 */
import { useState } from 'react';
import { useLocale } from 'next-intl';
import {
  DEFAULT_THEME,
  THEME_SETTINGS_SCHEMA,
  hexToHsl,
  hslToHex,
  isShown,
  overriddenLookKeys,
  traitDefault,
  type DraftTypography,
  type LookDefinition,
  type StoreTheme,
  type TemplateId,
  type ZoneOverride,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { ColorField } from '../../../../../components/ColorField';
import { Toggle } from '../../../../../components/Toggle';
import { SmartPaletteModal } from '../../../../../components/SmartPaletteModal';
import type { FontEntry } from '../../../../../components/section-design/FontsCard';
import { FontsField } from './FontsField';
import { TypographyZonesField } from './TypographyZonesField';
import { borderEditPatch } from './border-input-pairing';

export interface EffectiveTypography {
  fonts: FontEntry[];
  zones: Record<string, ZoneOverride | undefined>;
}

export function ThemeSettingsPanel({
  theme,
  onSave,
  storeId,
  look = null,
  onResetKey,
  typography,
  onTypography,
  onApplyPalette,
  storeTemplate,
}: {
  theme: StoreTheme | undefined;
  storeId?: string;
  /** The store's look; null/absent = legacy skin, no override tracking. */
  look?: LookDefinition | null;
  /** Reset one key to the look's default: a draft edit (`null` in the draft theme). True when saved. */
  onResetKey?: (key: string) => Promise<boolean>;
  /** Writes the patch into the draft and resolves true once the draft is saved. */
  onSave: (patch: Partial<StoreTheme>) => Promise<boolean>;
  /** The effective font library and zones (live + the draft patch). */
  typography?: EffectiveTypography;
  /** Merges a typography patch into the draft document. */
  onTypography?: (patch: DraftTypography) => void;
  /** Smart Palette applied: the caller writes section colours and the theme tokens into the draft. */
  onApplyPalette?: (
    palette: Parameters<React.ComponentProps<typeof SmartPaletteModal>['onApply']>[0],
    themeUpdates: Parameters<React.ComponentProps<typeof SmartPaletteModal>['onApply']>[1]
  ) => void;
  storeTemplate?: TemplateId;
}) {
  const t = useT('builder.theme');
  const locale = useLocale();
  const [patch, setPatch] = useState<Partial<StoreTheme>>({});
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const current = { ...(theme ?? DEFAULT_THEME), ...patch } as Record<string, unknown>;
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetFailed, setResetFailed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const overridden = new Set<string>(
    look && theme ? overriddenLookKeys(theme as unknown as Record<string, unknown>, look) : []
  );
  // A reset is a draft edit like any other (Ruling VE-4): the caller writes `null` for the key into the
  // draft theme and saves it; at Publish the key leaves the live theme, so the look's default shows.
  const resetOne = async (key: string) => {
    if (!onResetKey) return;
    setResetting(key);
    setResetFailed(false);
    try {
      if (!(await onResetKey(key))) return setResetFailed(true);
      setPatch(p => {
        const rest = { ...p };
        delete rest[key as keyof StoreTheme];
        return rest;
      });
    } catch {
      setResetFailed(true);
    } finally {
      setResetting(null);
    }
  };
  const set = (key: keyof StoreTheme, value: unknown) => {
    // A paired input colour follows a Borders edit (B1-43 follow-up, border-input-pairing.ts).
    const edit = borderEditPatch(current, key, value);
    setPatch(p => ({ ...p, ...edit }));
    setState('idle');
  };
  const save = async () => {
    setState('saving');
    const ok = await onSave(patch);
    if (!ok) return setState('error');
    setPatch({});
    setState('saved');
  };

  // Only the controls a renderer of this store's template reads (Ruling EP-1); a group left empty is not drawn.
  const groups = THEME_SETTINGS_SCHEMA.map(g => ({
    ...g,
    settings: g.settings.filter(s => isShown(s, { template: storeTemplate, look: look?.id })),
  })).filter(g => g.settings.length > 0);

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
    if (s.type === 'select') {
      // A trait the merchant has not set shows the look's own value; a header chrome key with no look
      // opinion shows "same as the look" until picked.
      const lookValue = s.trait ? traitDefault(String(s.id), look?.id) : undefined;
      const shown = typeof v === 'string' ? v : typeof lookValue === 'string' ? lookValue : '';
      const hint = locale === 'ar' ? s.hintAr : s.hintEn;
      return (
        <label key={s.id} className="block text-sm">
          <span className="mb-1 block text-xs font-semibold">{label}</span>
          <select
            value={shown}
            onChange={e => set(s.id, e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
          >
            {shown === '' &&
              (s.trait || s.id === 'headerLogoPlacement' || s.id === 'headerSearch') && (
                <option value="" disabled>
                  {t('inherit')}
                </option>
              )}
            {s.options?.map(o => (
              <option key={String(o.value)} value={String(o.value)}>
                {locale === 'ar' ? o.labelAr : o.labelEn}
              </option>
            ))}
          </select>
          {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
        </label>
      );
    }
    if (s.type === 'checkbox')
      return (
        <div key={s.id} className="space-y-0.5">
          <label className="flex items-center justify-between text-sm">
            <span>{label}</span>
            <Toggle checked={v === true} onChange={on => set(s.id, on)} />
          </label>
          {(locale === 'ar' ? s.hintAr : s.hintEn) && (
            <p className="text-xs text-muted-foreground">{locale === 'ar' ? s.hintAr : s.hintEn}</p>
          )}
        </div>
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
    return null;
  };

  return (
    <div className="flex h-full flex-col" data-testid="theme-settings">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {onApplyPalette && (
          <div className="space-y-1">
            <button
              type="button"
              data-testid="smart-palette"
              onClick={() => setPaletteOpen(true)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold hover:bg-muted"
            >
              {t('smartPalette')}
            </button>
            <p className="text-xs text-muted-foreground">{t('smartPaletteHint')}</p>
          </div>
        )}
        {groups.map(group => (
          <fieldset key={group.id} className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {locale === 'ar' ? group.labelAr : group.labelEn}
            </legend>
            {group.settings.map(s => {
              const field = (
                <>
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
                </>
              );
              // ⌘K anchors (admin-search registry): one literal per control, so the coverage test can find it.
              if (s.id === 'headerLogoPlacement')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.header-logo">
                    {field}
                  </div>
                );
              if (s.id === 'headerSearch')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.header-search">
                    {field}
                  </div>
                );
              if (s.id === 'headerWordmark')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.header-wordmark">
                    {field}
                  </div>
                );
              if (s.id === 'cardHeart')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-heart">
                    {field}
                  </div>
                );
              if (s.id === 'cardSwatches')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-swatches">
                    {field}
                  </div>
                );
              if (s.id === 'cardTags')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-tags">
                    {field}
                  </div>
                );
              if (s.id === 'gridGutter')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.grid-gutter">
                    {field}
                  </div>
                );
              if (s.id === 'headingWeight')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.heading-weight">
                    {field}
                  </div>
                );
              if (s.id === 'priceColour')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.price-colour">
                    {field}
                  </div>
                );
              if (s.id === 'tabBar')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.tab-bar">
                    {field}
                  </div>
                );
              if (s.id === 'heroRatio')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.hero-ratio">
                    {field}
                  </div>
                );
              if (s.id === 'showBrandBadge')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-brand-badge">
                    {field}
                  </div>
                );
              if (s.id === 'showNewBadge')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-new-badge">
                    {field}
                  </div>
                );
              if (s.id === 'showQuickAdd')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-quick-add">
                    {field}
                  </div>
                );
              if (s.id === 'normalizeProductImages')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-even-images">
                    {field}
                  </div>
                );
              if (s.id === 'saleBadgeLegacyCorner')
                return (
                  <div key={s.id} className="space-y-1" data-setting-id="builder.card-sale-corner">
                    {field}
                  </div>
                );
              return (
                <div key={s.id} className="space-y-1">
                  {field}
                </div>
              );
            })}
            {group.id === 'typography' && typography && onTypography && storeId && (
              <div className="space-y-4 pt-2">
                <FontsField
                  storeId={storeId}
                  fonts={typography.fonts}
                  onChange={fonts =>
                    onTypography({ fonts: fonts as NonNullable<DraftTypography['fonts']> })
                  }
                />
                <TypographyZonesField
                  zones={typography.zones}
                  theme={theme}
                  onChange={(zone, next) =>
                    onTypography({
                      zones: { [zone]: { ...(typography.zones[zone] ?? {}), ...next } },
                    })
                  }
                  onReset={zone => onTypography({ zones: { [zone]: null } })}
                />
              </div>
            )}
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
      {onApplyPalette && (
        <SmartPaletteModal
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          theme={theme}
          storeId={storeId}
          storeTemplate={storeTemplate}
          onApply={(palette, updates) => {
            onApplyPalette(palette, updates);
            setPaletteOpen(false);
          }}
        />
      )}
    </div>
  );
}
