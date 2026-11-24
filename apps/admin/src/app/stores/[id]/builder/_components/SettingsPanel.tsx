'use client';

/**
 * Right pane: settings GENERATED from the registry's settings schema for the
 * selected section or block — no hand-built form per section (gap #5).
 *
 * - Content / Design modes (Webstudio concept): Content shows `group:
 *   'content'` settings only.
 * - Bilingual settings (`localized`) show Arabic and English side by side,
 *   Arabic first, each input with its own `dir`.
 * - Per-viewport: while the canvas is on tablet/mobile, a setting the type
 *   declares responsive edits that viewport's override (with a reset), and
 *   the section's visibility is set per viewport.
 * - `typography` / `dividers` (compound editors) are the page builder's
 *   own blocks, shared (`components/section-design`), so nothing sends the
 *   merchant to the classic page (Ruling BUILDER2-ADVANCED-1, superseded by VE-6).
 */
import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { rovingKeyDown } from '../_lib/roving';
import { useLocale } from 'next-intl';
import {
  AI_FILL_SECTIONS,
  DEFAULT_THEME,
  VIEWPORTS,
  getSectionDefinition,
  isShown,
  isSafeUrl,
  locateSection,
  sectionVariants,
  type BlockNode,
  type DraftChrome,
  type DocumentAction,
  type PageDefinition,
  type SectionTypographyOverride,
  type SettingDefinition,
  type StoreTheme,
  type Viewport,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { ColorField } from '../../../../../components/ColorField';
import { Toggle } from '../../../../../components/Toggle';
import { Disclosure } from '../../../../../components/ui/Disclosure';
import { fieldControlClasses } from '../../../../../components/ui/Field';
import { apiGet } from '../../../../../lib/api';
import { ChromeContentPanel } from './ChromeContentPanel';
import { DividersField } from './DividersField';
import { SectionTypographyField } from './SectionTypographyField';
import { SectionSpacingField } from './SectionSpacingField';
import { ImageDropField } from './ImageDropField';
import { SegmentedEnum, SEGMENTED_MAX } from './SegmentedEnum';
import { SettingsEmptyState } from './SettingsEmptyState';
import { groupFieldErrors, type FieldIssue } from '../_lib/field-errors';
import { VideoField } from './VideoField';
import type { Selection } from './SectionTree';
import { fieldDefId } from '../_lib/deeplink';

type Mode = 'content' | 'design';

/** A path example, not copy: the same in every language. */
const PATH_EXAMPLE = '/products';

interface Props {
  storeId: string;
  doc: PageDefinition;
  selection: Selection | null;
  viewport: Viewport;
  /** Spacing's device tabs switch the editor's device (the canvas resizes with it). */
  onViewportChange?: (v: Viewport) => void;
  theme: StoreTheme | undefined;
  /** The store's resolved template and look: a control no renderer of it reads is not offered (EP-1). */
  template?: string | null;
  look?: string | null;
  errors: Array<{ path: string; messageEn: string; messageAr: string }>;
  dispatch: (a: DocumentAction, coalesceKey?: string) => void;
  /** Ask the AI for the section's kicker and subtitle (fills only the empty ones). */
  onAiFill?: (sectionId: string) => void;
  /** Header / footer content edits (menu, footer links): draft-only until Publish. */
  /** Deep link (Task 11): the control to open (design controls switch the panel to Design). */
  focusField?: string;
  chromeEdit?: {
    chrome: DraftChrome | undefined;
    liveVersion: number | null;
    onChange: (patch: DraftChrome) => void;
  };
}

export function SettingsPanel({
  storeId,
  doc,
  selection,
  viewport,
  onViewportChange,
  theme,
  template,
  look,
  errors,
  dispatch,
  onAiFill,
  focusField,
  chromeEdit,
}: Props) {
  const t = useT('builder.settings');
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>('content');
  const panelRef = useRef<HTMLDivElement>(null);
  const at = selection ? locateSection(doc, selection.sectionId) : null;
  // A deep link to a Design control opens the Design mode first, or the control is not rendered.
  useEffect(() => {
    if (!focusField || !selection) return;
    const found = locateSection(doc, selection.sectionId);
    const def = found ? getSectionDefinition(found.node.type) : undefined;
    const settings = !def
      ? []
      : selection.blockId
        ? (def.blocks.find(
            b => b.type === found?.node.blocks?.find(x => x.id === selection.blockId)?.type
          )?.settings ?? [])
        : def.settings;
    if (settings.some(s => s.id === fieldDefId(focusField) && s.group === 'design'))
      setMode('design');
    // doc is deliberately not a dependency: this runs when the link or the selection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusField, selection?.sectionId, selection?.blockId]);
  if (!selection || !at) {
    return <SettingsEmptyState />;
  }
  const node = at.node;
  const d = getSectionDefinition(node.type);
  if (!d) return <p className="p-4 text-sm text-muted-foreground">{t('unknownType')}</p>;
  const block: BlockNode | undefined = selection.blockId
    ? node.blocks?.find(b => b.id === selection.blockId)
    : undefined;
  const blockDef = block ? d.blocks.find(b => b.type === block.type) : undefined;
  const shownCtx = { template, look, variant: sectionVariants(d, node) };
  const defs = (blockDef ? blockDef.settings : d.settings).filter(
    s => (mode === 'design' || s.group === 'content') && isShown(s, shownCtx)
  );
  // Top / Bottom spacing is one grouped control at the top of Design (SectionSpacingField), not two
  // loose selects; typography and dividers sit behind "Advanced" (E-3).
  const hasSpacing = !block && d.settings.some(x => x.id === 'paddingTop' && isShown(x, shownCtx));
  const SPACING_IDS = ['paddingTop', 'paddingBottom'];
  const ADVANCED_TYPES = ['typography', 'dividers'];
  const plainDefs =
    hasSpacing && mode === 'design' ? defs.filter(x => !SPACING_IDS.includes(x.id)) : defs;
  const mainDefs =
    mode === 'design' && !block
      ? plainDefs.filter(x => !ADVANCED_TYPES.includes(x.type))
      : plainDefs;
  const advancedDefs =
    mode === 'design' && !block ? plainDefs.filter(x => ADVANCED_TYPES.includes(x.type)) : [];
  const values = block ? block.settings : node.settings;
  const vpOverrides =
    !block && viewport !== 'desktop' ? node.responsive?.[viewport]?.settings : undefined;
  const title = blockDef
    ? locale === 'ar'
      ? blockDef.labelAr
      : blockDef.labelEn
    : locale === 'ar'
      ? d.labelAr
      : d.labelEn;
  const sectionPath = `/${at.list === 'template' ? 'sections' : `sectionGroups/${at.list}`}/${at.index}`;
  const blockIndex = block ? (node.blocks ?? []).findIndex(b => b.id === block.id) : null;
  const { byDef: fieldErrors, loose: looseErrors } = groupFieldErrors(
    errors,
    sectionPath,
    blockIndex,
    defs
  );
  const sectionErrors = [...Object.values(fieldErrors).flat(), ...looseErrors];
  /** Jump from the summary to the field: open its mode, then focus its first control. */
  const jumpTo = (defId: string) => {
    const def = (blockDef ? blockDef.settings : d.settings).find(x => x.id === defId);
    if (def && def.group === 'design' && mode !== 'design') setMode('design');
    window.requestAnimationFrame(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(`[data-field-id="${defId}"]`);
      el?.scrollIntoView?.({ block: 'center' });
      el?.querySelector<HTMLElement>(
        'input,textarea,select,button[role="radio"][tabindex="0"]'
      )?.focus();
    });
  };
  const defIdOf = (e: FieldIssue) =>
    Object.keys(fieldErrors).find(k => fieldErrors[k].includes(e)) ?? null;

  const set = (s: SettingDefinition, key: string, value: unknown) => {
    const coalesce = `${node.id}/${block?.id ?? ''}/${key}`;
    if (block) {
      dispatch(
        { type: 'setBlockSetting', sectionId: node.id, blockId: block.id, key, value },
        coalesce
      );
    } else if (viewport !== 'desktop' && s.responsive?.includes(viewport)) {
      dispatch({ type: 'setViewportSetting', id: node.id, viewport, key, value }, coalesce);
    } else {
      dispatch({ type: 'setSectionSetting', id: node.id, key, value }, coalesce);
    }
  };
  const valueOf = (s: SettingDefinition, key: string) =>
    vpOverrides && s.responsive?.includes(viewport) && key in vpOverrides
      ? vpOverrides[key]
      : values[key];

  const renderDef = (s: SettingDefinition) => (
    <div key={s.id} data-field-id={s.id} className="group/field">
      <Field
        def={s}
        errors={fieldErrors[s.id]}
        storeId={storeId}
        theme={theme}
        locale={locale}
        valueOf={key => valueOf(s, key)}
        overridden={!!(vpOverrides && s.responsive?.includes(viewport) && s.id in vpOverrides)}
        viewport={viewport}
        onChange={(key, v) => set(s, key, v)}
        onReset={() =>
          dispatch({
            type: 'setViewportSetting',
            id: node.id,
            viewport,
            key: s.id,
            value: undefined,
          })
        }
        sectionType={node.type}
      />
    </div>
  );

  return (
    <div className="flex h-full flex-col" data-testid="settings-panel">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div
          role="tablist"
          aria-label={t('modeLabel')}
          onKeyDown={e => rovingKeyDown(e, 'tab')}
          className="mt-2 inline-flex rounded-md bg-muted p-1"
        >
          {(['content', 'design'] as const).map(m => (
            <button
              key={m}
              role="tab"
              type="button"
              id={`settings-mode-${m}`}
              aria-selected={mode === m}
              aria-controls="settings-mode-panel"
              tabIndex={mode === m ? 0 : -1}
              onClick={() => setMode(m)}
              className={`h-8 rounded-md px-3 text-sm font-medium transition-colors duration-150 motion-reduce:transition-none ${mode === m ? 'bg-card text-primary-ink shadow-sm' : 'text-muted-ink hover:text-foreground'}`}
            >
              {m === 'content' ? t('content') : t('design')}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={panelRef}
        role="tabpanel"
        id="settings-mode-panel"
        aria-labelledby={`settings-mode-${mode}`}
        className="flex-1 space-y-4 overflow-y-auto p-4"
      >
        {sectionErrors.length > 0 && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive-ink"
            data-testid="error-summary"
          >
            <p className="font-semibold">
              {t('errorsTitle', { count: String(sectionErrors.length) })}
            </p>
            <ul className="mt-1 space-y-0.5">
              {sectionErrors.map(e => {
                const text = locale === 'ar' ? e.messageAr : e.messageEn;
                const target = defIdOf(e);
                return (
                  <li key={e.path}>
                    {target ? (
                      <button
                        type="button"
                        onClick={() => jumpTo(target)}
                        className="text-start underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`error-jump-${target}`}
                      >
                        {text}
                      </button>
                    ) : (
                      text
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {hasSpacing && mode === 'design' && (
          <SectionSpacingField
            node={node}
            viewport={viewport}
            onViewportChange={onViewportChange}
            dispatch={dispatch}
          />
        )}
        {!block && mode === 'design' && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-muted-foreground">
              {t('visibility')}
            </legend>
            {VIEWPORTS.map(v => {
              const hiddenHere = node.responsive?.[v]?.hidden === true;
              return (
                <label key={v} className="flex items-center justify-between text-sm">
                  <span>{t(`viewport.${v}`)}</span>
                  <Toggle
                    checked={!hiddenHere && node.hidden !== true}
                    disabled={node.hidden === true}
                    onChange={on =>
                      dispatch({
                        type: 'setViewportHidden',
                        id: node.id,
                        viewport: v,
                        hidden: on ? undefined : true,
                      })
                    }
                  />
                </label>
              );
            })}
          </fieldset>
        )}
        {!block &&
          mode === 'content' &&
          chromeEdit &&
          (node.type === 'header' || node.type === 'footer') && (
            <ChromeContentPanel
              storeId={storeId}
              kind={node.type}
              chrome={chromeEdit.chrome}
              liveVersion={chromeEdit.liveVersion}
              onChange={chromeEdit.onChange}
            />
          )}
        {!block &&
          mode === 'content' &&
          defs.length === 0 &&
          !(chromeEdit && (node.type === 'header' || node.type === 'footer')) && (
            <ContentElsewhereNotice sectionType={node.type} storeId={storeId} t={t} />
          )}
        {!block && mode === 'content' && onAiFill && node.type in AI_FILL_SECTIONS && (
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => onAiFill(node.id)}
            data-testid="ai-fill"
          >
            {t('aiFill')}
          </Button>
        )}
        {mainDefs.map(renderDef)}
        {advancedDefs.length > 0 && (
          <AdvancedDesign
            title={t('advanced')}
            forceOpen={advancedDefs.some(x => x.id === (focusField ? fieldDefId(focusField) : ''))}
          >
            {advancedDefs.map(renderDef)}
          </AdvancedDesign>
        )}
      </div>
    </div>
  );
}

// These sections have no local content fields. Point to the verified source
// editor. The trust strip's items are blocks edited in the section list (add /
// remove / reorder); its notice only says so and links nowhere.
const CONTENT_ELSEWHERE: Record<string, { messageKey: string; route?: string; labelKey?: string }> =
  {
    announcement: {
      messageKey: 'announcementContentEmpty',
      route: 'announcement',
      labelKey: 'editAnnouncement',
    },
    'brand-story': {
      messageKey: 'brandStoryContentEmpty',
      route: 'branding',
      labelKey: 'editStoreDescription',
    },
    'trust-strip': { messageKey: 'trustStripContentEmpty' },
    // product / collection / cart pages: their content comes from the catalogue, not from a field here
    'product-main': {
      messageKey: 'productMainContent',
      route: 'products',
      labelKey: 'editProducts',
    },
    'product-faq': { messageKey: 'productFaqContent', route: 'products', labelKey: 'editProducts' },
    'product-reviews': {
      messageKey: 'productReviewsContent',
      route: 'reviews',
      labelKey: 'editReviews',
    },
    'product-bundles': {
      messageKey: 'productBundlesContent',
      route: 'bundles',
      labelKey: 'editBundles',
    },
    'product-recommendations': { messageKey: 'productRecommendationsContent' },
    'product-related': { messageKey: 'productRelatedContent' },
    'collection-main': {
      messageKey: 'collectionMainContent',
      route: 'categories',
      labelKey: 'editCategories',
    },
    'cart-main': { messageKey: 'cartMainContent' },
    'cart-recommendations': { messageKey: 'cartRecommendationsContent' },
  };

function ContentElsewhereNotice({
  sectionType,
  storeId,
  t,
}: {
  sectionType: string;
  storeId: string;
  t: (key: string) => string;
}) {
  const notice = CONTENT_ELSEWHERE[sectionType];
  if (!notice) return null;
  return (
    <div
      data-testid={`${sectionType}-content-elsewhere`}
      className="rounded-lg border border-dashed border-border p-2 text-xs text-muted-foreground"
    >
      {t(notice.messageKey)}
      {notice.route && notice.labelKey && (
        <>
          {' '}
          <a href={`/stores/${storeId}/${notice.route}`} className="text-primary hover:underline">
            {t(notice.labelKey)}
          </a>
        </>
      )}
    </div>
  );
}

export function Field({
  def,
  storeId,
  theme,
  locale,
  valueOf,
  overridden,
  viewport,
  onChange,
  onReset,
  sectionType,
  errors,
}: {
  def: SettingDefinition;
  storeId: string;
  theme: StoreTheme | undefined;
  locale: string;
  valueOf: (key: string) => unknown;
  overridden: boolean;
  viewport: Viewport;
  onChange: (key: string, value: unknown) => void;
  onReset: () => void;
  sectionType: string;
  /** Issues the API reported for this field: shown under the control (F56). */
  errors?: FieldIssue[];
}) {
  const t = useT('builder.settings');
  const label = locale === 'ar' ? def.labelAr : def.labelEn;
  const id = `setting-${def.id}`;
  const invalid = !!errors?.length;
  const errId = `${id}-error`;
  const ariaErr = {
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? errId : undefined,
  };
  const valueKeys = def.localized ? [def.id, `${def.id}Ar`] : [def.id];
  // One "Edited" cue for every field: a stored value that is not the default (F55).
  const edited =
    overridden ||
    valueKeys.some(k => {
      const v = valueOf(k);
      return (
        v !== undefined &&
        JSON.stringify(v) !== JSON.stringify(k === def.id ? def.default : undefined)
      );
    });
  const resetAll = () => {
    if (overridden) onReset();
    else for (const k of valueKeys) onChange(k, undefined);
  };
  const empty = (v: string) => (v === '' ? undefined : v);
  const str = (key: string) => (typeof valueOf(key) === 'string' ? (valueOf(key) as string) : '');

  const header = (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        {label}
        {edited && (
          <span
            role="img"
            aria-label={t('edited')}
            title={t('edited')}
            className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
            data-testid={`edited-${def.id}`}
          />
        )}
      </span>
      {overridden ? (
        <Button variant="link" size="sm" type="button" onClick={onReset}>
          {t('resetViewport', { viewport: t(`viewport.${viewport}`) })}
        </Button>
      ) : (
        edited && (
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={resetAll}
            aria-label={`${t('resetField')}: ${label}`}
            title={t('resetField')}
            className="text-muted-foreground opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/field:opacity-100 group-focus-within/field:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
            data-testid={`reset-${def.id}`}
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          </Button>
        )
      )}
    </div>
  );

  const body = (() => {
    switch (def.type) {
      case 'text':
      case 'textarea': {
        const Input = def.type === 'textarea' ? 'textarea' : 'input';
        const keys: Array<[string, 'rtl' | 'ltr', string]> = def.localized
          ? [
              [`${def.id}Ar`, 'rtl', t('arabic')],
              [def.id, 'ltr', t('english')],
            ]
          : [[def.id, locale === 'ar' ? 'rtl' : 'ltr', '']];
        return (
          <div>
            {header}
            <div className={def.localized ? 'grid grid-cols-1 gap-2 xl:grid-cols-2' : ''}>
              {keys.map(([key, dir, tag]) => (
                <label key={key} className="block">
                  {tag && <span className="mb-0.5 block text-xs text-muted-foreground">{tag}</span>}
                  <Input
                    id={`${id}-${key}`}
                    dir={dir}
                    // The visible name is a sibling span (the field) plus the language tag, so a
                    // screen reader would read "Arabic" alone, or nothing for a plain field.
                    aria-label={tag ? `${label} - ${tag}` : label}
                    value={str(key)}
                    {...ariaErr}
                    rows={def.type === 'textarea' ? 3 : undefined}
                    onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                      onChange(key, empty(e.target.value))
                    }
                    className={fieldControlClasses()}
                    data-testid={`field-${key}`}
                  />
                </label>
              ))}
            </div>
          </div>
        );
      }
      case 'url': {
        const v = str(def.id);
        const bad = v !== '' && !isSafeUrl(v);
        return (
          <div>
            {header}
            <input
              id={id}
              aria-label={label}
              dir="ltr"
              value={v}
              aria-invalid={bad || invalid || undefined}
              aria-describedby={invalid ? errId : undefined}
              onChange={e => onChange(def.id, empty(e.target.value))}
              placeholder={PATH_EXAMPLE}
              className={fieldControlClasses()}
            />
            {bad && (
              <span className="mt-1 block text-xs text-destructive-ink">{t('unsafeUrl')}</span>
            )}
          </div>
        );
      }
      case 'image':
        return (
          <div>
            {header}
            <div className={def.localized ? 'grid grid-cols-2 gap-2' : ''}>
              {(def.localized
                ? [
                    [`${def.id}Ar`, t('arabic')],
                    [def.id, t('english')],
                  ]
                : [[def.id, '']]
              ).map(([key, tag]) => (
                <ImageDropField
                  key={key}
                  storeId={storeId}
                  label={label}
                  tag={tag}
                  value={str(key)}
                  onChange={v => onChange(key, v)}
                />
              ))}
            </div>
          </div>
        );
      case 'video':
        return (
          <div>
            {header}
            <div className={def.localized ? 'grid grid-cols-2 gap-2' : ''}>
              {(def.localized
                ? [
                    [`${def.id}Ar`, t('arabic')],
                    [def.id, t('english')],
                  ]
                : [[def.id, '']]
              ).map(([key, tag]) => (
                <VideoField
                  key={key}
                  storeId={storeId}
                  tag={tag}
                  value={str(key)}
                  onChange={v => onChange(key, v)}
                />
              ))}
            </div>
          </div>
        );
      case 'color':
        return (
          <ColorField
            label={label}
            value={str(def.id) || undefined}
            onChange={v => onChange(def.id, empty(v))}
            theme={theme ?? DEFAULT_THEME}
          />
        );
      case 'select': {
        const opts = def.options ?? [];
        const hint = def.hintEn && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {locale === 'ar' ? (def.hintAr ?? def.hintEn) : def.hintEn}
          </span>
        );
        // A few named choices read at a glance as one segmented control (F52). A longer list stays a
        // select. No layout thumbnails exist for these options, so there are no pictogram tiles.
        if (opts.length > 0 && opts.length <= SEGMENTED_MAX) {
          const current = valueOf(def.id);
          return (
            <div>
              {header}
              <SegmentedEnum
                label={label}
                options={opts.map(o => ({
                  value: o.value,
                  label: locale === 'ar' ? o.labelAr : o.labelEn,
                }))}
                value={current === undefined ? def.default : current}
                onPick={v => onChange(def.id, v)}
                invalid={invalid}
                describedBy={invalid ? errId : undefined}
                testId={`field-${def.id}`}
              />
              {hint}
            </div>
          );
        }
        return (
          <div>
            {header}
            <select
              id={id}
              aria-label={label}
              value={valueOf(def.id) === undefined ? '' : String(valueOf(def.id))}
              onChange={e => {
                const opt = def.options?.find(o => String(o.value) === e.target.value);
                onChange(def.id, opt ? opt.value : undefined);
              }}
              {...ariaErr}
              className={fieldControlClasses()}
            >
              <option value="">{t('default')}</option>
              {def.options?.map(o => (
                <option key={String(o.value)} value={String(o.value)}>
                  {locale === 'ar' ? o.labelAr : o.labelEn}
                </option>
              ))}
            </select>
            {def.hintEn && (
              <span className="mt-1 block text-xs text-muted-foreground">
                {locale === 'ar' ? (def.hintAr ?? def.hintEn) : def.hintEn}
              </span>
            )}
          </div>
        );
      }
      case 'range': {
        const v = typeof valueOf(def.id) === 'number' ? (valueOf(def.id) as number) : '';
        return (
          <div>
            {header}
            <input
              id={id}
              aria-label={label}
              type="number"
              dir="ltr"
              min={def.min}
              max={def.max}
              step={def.step ?? 1}
              value={v}
              {...ariaErr}
              onChange={e =>
                onChange(
                  def.id,
                  e.target.value === ''
                    ? undefined
                    : Math.min(
                        def.max ?? Infinity,
                        Math.max(def.min ?? -Infinity, Number(e.target.value))
                      )
                )
              }
              className={fieldControlClasses('w-28')}
            />
          </div>
        );
      }
      case 'checkbox':
        return (
          <label className="flex items-center justify-between text-sm">
            <span>{label}</span>
            <Toggle checked={valueOf(def.id) === true} onChange={on => onChange(def.id, on)} />
          </label>
        );
      case 'category':
        return (
          <div>
            {header}
            <CategoryPicker
              storeId={storeId}
              label={label}
              value={str(def.id)}
              locale={locale}
              onChange={v => onChange(def.id, v)}
            />
          </div>
        );
      case 'product_list':
        return (
          <div>
            {header}
            <ProductListPicker
              storeId={storeId}
              label={label}
              value={Array.isArray(valueOf(def.id)) ? (valueOf(def.id) as string[]) : []}
              max={def.max ?? 50}
              locale={locale}
              onChange={v => onChange(def.id, v.length ? v : undefined)}
            />
          </div>
        );
      case 'typography':
        return (
          <SectionTypographyField
            storeId={storeId}
            sectionType={sectionType}
            value={valueOf(def.id) as SectionTypographyOverride | undefined}
            theme={theme}
            onChange={next => onChange(def.id, next)}
          />
        );
      case 'dividers':
        return (
          <DividersField
            sectionType={sectionType}
            settings={{
              dividers: valueOf(def.id),
              showKickerLines: valueOf('showKickerLines'),
              showSubtitleLines: valueOf('showSubtitleLines'),
            }}
            theme={theme}
            onChange={next => onChange(def.id, next)}
          />
        );
    }
  })();
  if (!invalid) return body;
  return (
    <>
      {body}
      <ul
        id={errId}
        className="mt-1 space-y-0.5 text-xs text-destructive-ink"
        data-testid={`error-${def.id}`}
      >
        {errors!.map(e => (
          <li key={e.path}>{locale === 'ar' ? e.messageAr : e.messageEn}</li>
        ))}
      </ul>
    </>
  );
}

interface NamedRow {
  id: string;
  slug?: string;
  name: string;
  nameAr?: string | null;
}

function CategoryPicker({
  storeId,
  label,
  value,
  locale,
  onChange,
}: {
  storeId: string;
  label: string;
  value: string;
  locale: string;
  onChange: (v: string | undefined) => void;
}) {
  const t = useT('builder.settings');
  const [cats, setCats] = useState<NamedRow[]>([]);
  useEffect(() => {
    void apiGet<{ categories: NamedRow[] }>(`/api/v1/stores/${storeId}/categories`).then(r =>
      setCats(r.data?.categories ?? [])
    );
  }, [storeId]);
  return (
    <select
      aria-label={label}
      value={value}
      onChange={e => onChange(e.target.value || undefined)}
      className={fieldControlClasses()}
    >
      <option value="">{t('pickCategory')}</option>
      {cats.map(c => (
        <option key={c.id} value={c.slug}>
          {locale === 'ar' && c.nameAr ? c.nameAr : c.name}
        </option>
      ))}
    </select>
  );
}

function ProductListPicker({
  storeId,
  label,
  value,
  max,
  locale,
  onChange,
}: {
  storeId: string;
  label: string;
  value: string[];
  max: number;
  locale: string;
  onChange: (v: string[]) => void;
}) {
  const t = useT('builder.settings');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<NamedRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = new URLSearchParams({ limit: '10' });
      if (query) q.set('search', query);
      void apiGet<{ products: NamedRow[] }>(
        `/api/v1/stores/${storeId}/products?${q.toString()}`
      ).then(r => {
        const rows = r.data?.products ?? [];
        setFound(rows);
        setNames(prev => ({
          ...prev,
          ...Object.fromEntries(
            rows.map(p => [p.id, locale === 'ar' && p.nameAr ? p.nameAr : p.name])
          ),
        }));
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [storeId, query, locale]);
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1">
        {value.map(id => (
          <li
            key={id}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
          >
            {names[id] ?? id.slice(0, 8)}
            <button
              type="button"
              aria-label={`${t('removeProduct')}: ${names[id] ?? id.slice(0, 8)}`}
              onClick={() => onChange(value.filter(v => v !== id))}
              className="text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <input
        aria-label={`${label}: ${t('searchProducts')}`}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('searchProducts')}
        className={fieldControlClasses()}
      />
      <ul className="max-h-40 space-y-0.5 overflow-y-auto">
        {found
          .filter(p => !value.includes(p.id))
          .map(p => (
            <li key={p.id}>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={value.length >= max}
                onClick={() => onChange([...value, p.id])}
                className="w-full truncate justify-start"
              >
                + {locale === 'ar' && p.nameAr ? p.nameAr : p.name}
              </Button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** The design pane's Advanced group: closed by default, opened for the merchant when a deep link targets it. */
function AdvancedDesign({
  title,
  forceOpen,
  children,
}: {
  title: string;
  forceOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <Disclosure testId="advanced-design" title={title} open={open} onOpenChange={setOpen}>
      <div className="space-y-4">{children}</div>
    </Disclosure>
  );
}
