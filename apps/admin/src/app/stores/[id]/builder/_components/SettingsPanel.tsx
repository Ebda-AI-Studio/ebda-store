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
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import {
  AI_FILL_SECTIONS,
  DEFAULT_THEME,
  VIEWPORTS,
  getSectionDefinition,
  isSafeUrl,
  locateSection,
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
import { apiGet } from '../../../../../lib/api';
import { ChromeContentPanel } from './ChromeContentPanel';
import { DividersField } from './DividersField';
import { SectionTypographyField } from './SectionTypographyField';
import { MediaPicker } from './MediaPicker';
import { VideoField } from './VideoField';
import type { Selection } from './SectionTree';

type Mode = 'content' | 'design';

/** A path example, not copy: the same in every language. */
const PATH_EXAMPLE = '/products';

interface Props {
  storeId: string;
  doc: PageDefinition;
  selection: Selection | null;
  viewport: Viewport;
  theme: StoreTheme | undefined;
  errors: Array<{ path: string; messageEn: string; messageAr: string }>;
  dispatch: (a: DocumentAction, coalesceKey?: string) => void;
  /** Ask the AI for the section's kicker and subtitle (fills only the empty ones). */
  onAiFill?: (sectionId: string) => void;
  /** Header / footer content edits (menu, footer links): draft-only until Publish. */
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
  theme,
  errors,
  dispatch,
  onAiFill,
  chromeEdit,
}: Props) {
  const t = useT('builder.settings');
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>('content');
  const at = selection ? locateSection(doc, selection.sectionId) : null;
  if (!selection || !at) {
    return <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p>;
  }
  const node = at.node;
  const d = getSectionDefinition(node.type);
  if (!d) return <p className="p-4 text-sm text-muted-foreground">{t('unknownType')}</p>;
  const block: BlockNode | undefined = selection.blockId
    ? node.blocks?.find(b => b.id === selection.blockId)
    : undefined;
  const blockDef = block ? d.blocks.find(b => b.type === block.type) : undefined;
  const defs = (blockDef ? blockDef.settings : d.settings).filter(
    s => mode === 'design' || s.group === 'content'
  );
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
  const sectionErrors = errors.filter(e => e.path.startsWith(sectionPath));

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

  return (
    <div className="flex h-full flex-col" data-testid="settings-panel">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div
          role="tablist"
          aria-label={t('modeLabel')}
          className="mt-2 inline-flex rounded-lg bg-muted p-0.5 text-xs"
        >
          {(['content', 'design'] as const).map(m => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 ${mode === m ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'}`}
            >
              {m === 'content' ? t('content') : t('design')}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {sectionErrors.length > 0 && (
          <ul
            role="alert"
            className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive-ink"
          >
            {sectionErrors.map(e => (
              <li key={e.path}>{locale === 'ar' ? e.messageAr : e.messageEn}</li>
            ))}
          </ul>
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
          <button
            type="button"
            onClick={() => onAiFill(node.id)}
            data-testid="ai-fill"
            className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary-ink hover:bg-primary/10"
          >
            {t('aiFill')}
          </button>
        )}
        {defs.map(s => (
          <Field
            key={s.id}
            def={s}
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
        ))}
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

function Field({
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
}) {
  const t = useT('builder.settings');
  const label = locale === 'ar' ? def.labelAr : def.labelEn;
  const id = `setting-${def.id}`;
  const empty = (v: string) => (v === '' ? undefined : v);
  const str = (key: string) => (typeof valueOf(key) === 'string' ? (valueOf(key) as string) : '');

  const header = (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      {overridden && (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-primary hover:underline"
        >
          {t('resetViewport', { viewport: t(`viewport.${viewport}`) })}
        </button>
      )}
    </div>
  );

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
                {tag && (
                  <span className="mb-0.5 block text-[11px] text-muted-foreground">{tag}</span>
                )}
                <Input
                  id={`${id}-${key}`}
                  dir={dir}
                  value={str(key)}
                  rows={def.type === 'textarea' ? 3 : undefined}
                  onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                    onChange(key, empty(e.target.value))
                  }
                  className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
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
        <label className="block">
          {header}
          <input
            id={id}
            dir="ltr"
            value={v}
            aria-invalid={bad}
            onChange={e => onChange(def.id, empty(e.target.value))}
            placeholder={PATH_EXAMPLE}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
          />
          {bad && (
            <span className="mt-1 block text-[11px] text-destructive-ink">{t('unsafeUrl')}</span>
          )}
        </label>
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
              <ImageField
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
    case 'select':
      return (
        <label className="block">
          {header}
          <select
            id={id}
            value={valueOf(def.id) === undefined ? '' : String(valueOf(def.id))}
            onChange={e => {
              const opt = def.options?.find(o => String(o.value) === e.target.value);
              onChange(def.id, opt ? opt.value : undefined);
            }}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
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
        </label>
      );
    case 'range': {
      const v = typeof valueOf(def.id) === 'number' ? (valueOf(def.id) as number) : '';
      return (
        <label className="block">
          {header}
          <input
            id={id}
            type="number"
            dir="ltr"
            min={def.min}
            max={def.max}
            step={def.step ?? 1}
            value={v}
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
            className="w-28 rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
          />
        </label>
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
}

function ImageField({
  storeId,
  tag,
  value,
  onChange,
}: {
  storeId: string;
  tag: string;
  value: string;
  onChange: (v: string | undefined) => void;
}) {
  const t = useT('builder.settings');
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      {tag && <span className="mb-0.5 block text-[11px] text-muted-foreground">{tag}</span>}
      <div className="flex items-center gap-2">
        {value ? (
          <img
            src={value}
            alt=""
            className="h-12 w-12 rounded-md border border-border object-cover"
          />
        ) : (
          <span
            className="h-12 w-12 rounded-md border border-dashed border-border"
            aria-hidden="true"
          />
        )}
        <div className="flex flex-col items-start gap-0.5">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-xs font-medium text-primary hover:underline"
          >
            {value ? t('changeImage') : t('chooseImage')}
          </button>
          {value && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="text-xs text-muted-foreground hover:underline"
            >
              {t('removeImage')}
            </button>
          )}
        </div>
      </div>
      {open && (
        <MediaPicker
          storeId={storeId}
          onClose={() => setOpen(false)}
          onPick={url => {
            onChange(url);
            setOpen(false);
          }}
        />
      )}
    </div>
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
  value,
  locale,
  onChange,
}: {
  storeId: string;
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
      value={value}
      onChange={e => onChange(e.target.value || undefined)}
      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
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
  value,
  max,
  locale,
  onChange,
}: {
  storeId: string;
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
              aria-label={t('removeProduct')}
              onClick={() => onChange(value.filter(v => v !== id))}
              className="text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('searchProducts')}
        className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-base sm:text-sm"
      />
      <ul className="max-h-40 space-y-0.5 overflow-y-auto">
        {found
          .filter(p => !value.includes(p.id))
          .map(p => (
            <li key={p.id}>
              <button
                type="button"
                disabled={value.length >= max}
                onClick={() => onChange([...value, p.id])}
                className="w-full truncate rounded px-2 py-1 text-start text-xs hover:bg-muted disabled:opacity-40"
              >
                + {locale === 'ar' && p.nameAr ? p.nameAr : p.name}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
