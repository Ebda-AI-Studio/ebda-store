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
  lookTheme,
  overriddenLookKeys,
  traitDefault,
  type DraftTypography,
  type LookDefinition,
  type StoreTheme,
  type TemplateId,
  type ZoneOverride,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Toggle } from '../../../../../components/Toggle';
import { ColorField } from '../../../../../components/ColorField';
import { SmartPaletteModal } from '../../../../../components/SmartPaletteModal';
import type { FontEntry } from '../../../../../components/section-design/FontsCard';
import { FontsField } from './FontsField';
import { TypographyZonesField } from './TypographyZonesField';
import { borderEditPatch } from './border-input-pairing';
import {
  CORNER_BANDS,
  THEME_PRESETS,
  TIER2_ORDER,
  cornerBandOf,
  matchesQuery,
  placementOf,
  presetIsActive,
  presetPatch,
  type Tier2Id,
} from './theme-panel-model';

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
  const [query, setQuery] = useState('');
  const [openTier, setOpenTier] = useState<Tier2Id | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
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
  // `density` scales the look's section rhythm, so only a store with a look is offered it.
  const groups = THEME_SETTINGS_SCHEMA.map(g => ({
    ...g,
    settings: g.settings.filter(
      s => isShown(s, { template: storeTemplate, look: look?.id }) && (s.id !== 'density' || !!look)
    ),
  })).filter(g => g.settings.length > 0);
  const all = groups.flatMap(g => g.settings);
  type Setting = (typeof all)[number];
  const byId = (id: string) => all.find(s => s.id === id);
  const labelOf = (s: Setting) => (locale === 'ar' ? s.labelAr : s.labelEn);
  const lookBase = look ? (lookTheme(look) as Record<string, unknown>) : {};
  const changed = (id: string) => overridden.has(id) || id in patch;
  const hasChanges = Object.keys(patch).length > 0 || overridden.size > 0;

  const resetAll = async () => {
    setConfirmAll(false);
    setPatch({});
    setState('idle');
    for (const key of overridden) await resetOne(key);
  };

  /**
   * A colour: the shared ColorField (repo rule: ColorField everywhere), bridged because the theme stores Tailwind HSL
   * triplets ("H S% L%") while the field speaks hex. A brand token (`token:...`) passes through untouched.
   */
  const renderSwatch = (s: Setting) => {
    const v = current[s.id];
    const stored = typeof v === 'string' ? v.trim() : '';
    const shown =
      !stored || stored.startsWith('token:') || stored.startsWith('#') ? stored : hslToHex(stored);
    return (
      <ColorField
        key={s.id}
        label={labelOf(s)}
        value={shown}
        theme={theme}
        showContrastPreview={false}
        onChange={next => {
          // Clear = back to the look's default (a draft reset), never an empty string in the theme.
          if (!next) void resetOne(String(s.id));
          else set(s.id, next.startsWith('#') ? hexToHsl(next) : next);
        }}
      />
    );
  };

  const renderField = (s: Setting) => {
    const label = labelOf(s);
    const v = current[s.id];
    if (s.type === 'color') return renderSwatch(s);
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

  /** One setting with its "Edited" badge, reset link and ⌘K anchor. */
  const renderBlock = (s: Setting, control?: React.ReactNode) => {
    const field = (
      <>
        {control ?? renderField(s)}
        {overridden.has(String(s.id)) && (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
              {t('edited')}
            </span>
            <button
              type="button"
              disabled={resetting !== null}
              aria-label={t('resetOne', { field: labelOf(s) })}
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
  };

  const segmented = (
    s: Setting,
    options: Array<{ id: string; label: string }>,
    active: string | undefined,
    pick: (id: string) => void
  ) =>
    renderBlock(
      s,
      <div role="radiogroup" aria-label={labelOf(s)} className="space-y-1.5" data-feel={s.id}>
        <span className="block text-xs font-semibold">{labelOf(s)}</span>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        >
          {options.map(o => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active === o.id}
              data-testid={`feel-${s.id}-${o.id}`}
              onClick={() => pick(o.id)}
              className={`min-h-11 rounded-lg border px-2 py-1.5 text-sm ${
                active === o.id
                  ? 'border-primary bg-primary/10 font-semibold text-primary-ink'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );

  const renderFeel = () => {
    const out: React.ReactNode[] = [];
    const density = byId('density');
    if (density) {
      const cur = (typeof current.density === 'string' ? current.density : lookBase.density) as
        | string
        | undefined;
      out.push(
        segmented(
          density,
          (density.options ?? []).map(o => ({
            id: String(o.value),
            label: locale === 'ar' ? o.labelAr : o.labelEn,
          })),
          cur,
          id => set('density', id)
        )
      );
    }
    const radius = byId('borderRadius');
    if (radius) {
      out.push(
        segmented(
          radius,
          CORNER_BANDS.map(b => ({ id: b.id, label: t(`corner.${b.id}`) })),
          cornerBandOf(current.borderRadius),
          id => set('borderRadius', CORNER_BANDS.find(b => b.id === id)!.write)
        )
      );
    }
    const font = byId('fontFamily');
    if (font) {
      out.push(
        segmented(
          font,
          (font.options ?? []).map(o => ({
            id: String(o.value),
            label: locale === 'ar' ? o.labelAr : o.labelEn,
          })),
          typeof current.fontFamily === 'string' ? current.fontFamily : 'default',
          id => set('fontFamily', id)
        )
      );
    }
    return out;
  };

  const inTier = (p: string) => all.filter(s => placementOf(String(s.id)) === p);
  const advanced = inTier('advanced');
  const searching = query.trim().length > 0;
  const hits = all.filter(s => matchesQuery(s, query));
  const fontsMatch = /font|type|خط/i.test(query);

  const fontTools =
    typography && onTypography && storeId ? (
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
            onTypography({ zones: { [zone]: { ...(typography.zones[zone] ?? {}), ...next } } })
          }
          onReset={zone => onTypography({ zones: { [zone]: null } })}
        />
      </div>
    ) : null;

  const tierGroup = (id: Tier2Id) => {
    const items = inTier(id);
    if (items.length === 0) return null;
    return (
      <details
        key={id}
        data-testid={`tier2-${id}`}
        open={openTier === id}
        onToggle={e => {
          const isOpen = (e.currentTarget as HTMLDetailsElement).open;
          setOpenTier(prev => (isOpen ? id : prev === id ? null : prev));
        }}
        className="rounded-lg border border-border"
      >
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 text-sm font-semibold">
          <span>{t(`tier.${id}`)}</span>
          {items.some(s => changed(String(s.id))) && (
            <span aria-label={t('changedDot')} className="h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </summary>
        <div className="space-y-3 border-t border-border p-3">{items.map(s => renderBlock(s))}</div>
      </details>
    );
  };

  return (
    <div className="flex h-full flex-col" data-testid="theme-settings">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            data-testid="theme-search"
            className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base sm:text-sm"
          />
        </div>
        {hasChanges && (
          <div className="flex items-center justify-between gap-2 text-xs">
            {confirmAll ? (
              <>
                <span>{t('resetAllConfirm')}</span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    data-testid="reset-all-yes"
                    onClick={() => void resetAll()}
                    className="min-h-11 rounded-lg px-3 font-semibold text-primary-ink underline"
                  >
                    {t('resetAllYes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAll(false)}
                    className="min-h-11 rounded-lg px-3 text-muted-foreground"
                  >
                    {t('cancel')}
                  </button>
                </span>
              </>
            ) : (
              <button
                type="button"
                data-testid="reset-all"
                onClick={() => setConfirmAll(true)}
                className="min-h-11 rounded-lg px-1 font-medium text-primary-ink underline"
              >
                {t('resetAll')}
              </button>
            )}
          </div>
        )}
        {searching ? (
          <div className="space-y-3" data-testid="theme-search-results">
            {hits.length === 0 && !fontsMatch && (
              <p className="text-sm text-muted-foreground">{t('searchEmpty')}</p>
            )}
            {hits.map(s => renderBlock(s))}
            {fontsMatch && fontTools}
          </div>
        ) : (
          <>
            <section className="space-y-3" data-testid="theme-quick" aria-label={t('quick')}>
              <div role="group" aria-label={t('presets')} className="grid grid-cols-3 gap-2">
                {THEME_PRESETS.map(p => {
                  const on = presetIsActive(p, current);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      data-testid={`preset-${p.id}`}
                      onClick={() => {
                        const edit = presetPatch(p);
                        setPatch(prev => ({ ...prev, ...edit }));
                        setState('idle');
                      }}
                      className={`min-h-11 space-y-1.5 rounded-lg border p-1.5 text-xs ${on ? 'border-primary bg-primary/10 font-semibold' : 'border-border hover:bg-muted'}`}
                    >
                      <span
                        className="flex h-7 overflow-hidden rounded-md border border-border"
                        aria-hidden="true"
                      >
                        <span className="flex-1" style={{ background: p.background }} />
                        <span className="flex-1" style={{ background: p.primary }} />
                        <span className="flex-1" style={{ background: p.foreground }} />
                      </span>
                      <span className="block truncate">
                        {locale === 'ar' ? p.labelAr : p.labelEn}
                      </span>
                    </button>
                  );
                })}
              </div>
              {onApplyPalette && (
                <div className="space-y-1">
                  <button
                    type="button"
                    data-testid="smart-palette"
                    onClick={() => setPaletteOpen(true)}
                    className="min-h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold hover:bg-muted"
                  >
                    {t('smartPalette')}
                  </button>
                  <p className="text-xs text-muted-foreground">{t('smartPaletteHint')}</p>
                </div>
              )}
              <div className="space-y-1">{inTier('quick-color').map(s => renderBlock(s))}</div>
              <div className="space-y-4">{renderFeel()}</div>
            </section>
            <div className="space-y-2">{TIER2_ORDER.map(tierGroup)}</div>
            <details data-testid="theme-advanced" className="rounded-lg border border-border">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-semibold">
                {t('advanced')}
              </summary>
              <div className="space-y-3 border-t border-border p-3">
                {advanced.map(s => renderBlock(s))}
                {fontTools}
              </div>
            </details>
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border p-3">
        <span role="status" className="text-xs text-muted-foreground">
          {resetFailed
            ? t('resetError')
            : state === 'saved'
              ? t('saved')
              : state === 'error'
                ? t('error')
                : t('draftNote')}
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
