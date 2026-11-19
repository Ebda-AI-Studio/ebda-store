'use client';

/**
 * Content tab for the HEADER and FOOTER sections of the visual editor: the
 * menu links, the utility bar and the footer link columns.
 *
 * Same data shapes as the classic builder (`stores.settings.navMenu`,
 * `footerLinks`, `utilityBar` — see NavMenuEditor / FooterLinksEditor), but the
 * edits go into the DRAFT document (`PageDefinition.chrome`) and become live
 * only on Publish. The current live values are the starting point; until a list
 * is edited here nothing is stored for it.
 *
 * Every link is checked with `isSafeUrl` before it reaches the draft: a value
 * that is not a relative path or http(s)/mailto/tel stays in the field with an
 * inline error and is never dispatched (the API schema rejects it too).
 */
import { fieldControlClasses } from '../../../../../components/ui/Field';
import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import {
  FOOTER_COLUMNS,
  MAX_FOOTER_LINKS_PER_COLUMN,
  MAX_NAV_ITEMS,
  MAX_UTILITY_LINKS,
  isSafeUrl,
  type DraftChrome,
  type FooterColumn,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Toggle } from '../../../../../components/Toggle';
import { apiGet } from '../../../../../lib/api';
import { DEFAULT_MENU } from '../../../../../components/NavMenuEditor';
import {
  DEFAULT_COMPANY_LINKS,
  DEFAULT_SHOP_LINKS,
  DEFAULT_SUPPORT_LINKS,
  DEFAULT_UTILITY_LINKS,
} from '../../../../../components/FooterLinksEditor';

/** One editable row; footer/utility `name` and `label` are both `label` here. */
interface Row {
  label: string;
  labelAr: string;
  href: string;
  enabled?: boolean;
}

type Settings = Record<string, unknown>;
const obj = (v: unknown): Settings =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Settings) : {};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function rowsFrom(value: unknown, labelKey: 'label' | 'name', fallback: Row[]): Row[] {
  if (!Array.isArray(value)) return fallback;
  const rows = value
    .filter(v => v && typeof v === 'object' && typeof obj(v).href === 'string')
    .map(v => {
      const o = obj(v);
      return {
        label: str(o[labelKey]),
        labelAr: str(o[`${labelKey}Ar`]),
        href: str(o.href),
        enabled: typeof o.enabled === 'boolean' ? o.enabled : undefined,
      };
    });
  return rows.length > 0 ? rows : fallback;
}

const fromDefaults = (
  items: Array<{ label?: string; name?: string; labelAr?: string; nameAr?: string; href: string }>
): Row[] =>
  items.map(i => ({
    label: i.label ?? i.name ?? '',
    labelAr: i.labelAr ?? i.nameAr ?? '',
    href: i.href,
    enabled: true,
  }));

const DEFAULT_COLUMNS: Record<FooterColumn, Row[]> = {
  shop: fromDefaults(DEFAULT_SHOP_LINKS),
  support: fromDefaults(DEFAULT_SUPPORT_LINKS),
  company: fromDefaults(DEFAULT_COMPANY_LINKS),
};

/** Rows -> the stored shape (`name` for footer columns, `label` otherwise). */
function toStored(rows: Row[], labelKey: 'label' | 'name', withEnabled = true) {
  return rows.map(r => ({
    [labelKey]: r.label,
    ...(r.labelAr ? { [`${labelKey}Ar`]: r.labelAr } : {}),
    href: r.href,
    ...(withEnabled && r.enabled !== undefined ? { enabled: r.enabled } : {}),
  }));
}

function LinkList({
  title,
  testId,
  initial,
  max,
  onCommit,
}: {
  title: string;
  testId: string;
  initial: Row[];
  max: number;
  onCommit: (rows: Row[]) => void;
}) {
  const t = useT('builder.settings');
  const [rows, setRows] = useState(initial);

  const update = (next: Row[]) => {
    setRows(next);
    // A half-typed or unsafe link stays local: nothing unsafe reaches the draft.
    if (next.every(r => r.href === '' || isSafeUrl(r.href))) onCommit(next);
  };
  const edit = (i: number, patch: Partial<Row>) =>
    update(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };

  const input = fieldControlClasses();
  return (
    <fieldset className="space-y-2" data-testid={testId}>
      <legend className="text-xs font-semibold text-foreground">{title}</legend>
      {rows.map((r, i) => {
        const bad = r.href !== '' && !isSafeUrl(r.href);
        return (
          <div key={i} className="space-y-1.5 rounded-lg border border-border p-2">
            <div className="grid grid-cols-1 gap-1.5 xl:grid-cols-2">
              <label className="block">
                <span className="mb-0.5 block text-xs text-muted-foreground">
                  {t('chromeLabelAr')}
                </span>
                <input
                  dir="rtl"
                  value={r.labelAr}
                  maxLength={80}
                  onChange={e => edit(i, { labelAr: e.target.value })}
                  className={input}
                  data-testid={`${testId}-labelAr-${i}`}
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-xs text-muted-foreground">
                  {t('chromeLabelEn')}
                </span>
                <input
                  dir="ltr"
                  value={r.label}
                  maxLength={80}
                  onChange={e => edit(i, { label: e.target.value })}
                  className={input}
                  data-testid={`${testId}-label-${i}`}
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-0.5 block text-xs text-muted-foreground">{t('chromeLink')}</span>
              <input
                dir="ltr"
                value={r.href}
                maxLength={500}
                aria-invalid={bad}
                placeholder="/products"
                onChange={e => edit(i, { href: e.target.value })}
                className={`${input} ${bad ? 'border-destructive' : ''}`}
                data-testid={`${testId}-href-${i}`}
              />
            </label>
            {bad && (
              <p role="alert" className="text-xs text-destructive-ink">
                {t('chromeUnsafeLink')}
              </p>
            )}
            <div className="flex items-center gap-1 text-xs">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
              >
                {t('chromeUp')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === rows.length - 1}
              >
                {t('chromeDown')}
              </Button>
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => update(rows.filter((_, idx) => idx !== i))}
                className="text-destructive-ink"
                data-testid={`${testId}-remove-${i}`}
              >
                {t('chromeRemove')}
              </Button>
            </div>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={rows.length >= max}
        onClick={() => update([...rows, { label: '', labelAr: '', href: '/', enabled: true }])}
        data-testid={`${testId}-add`}
      >
        {t('chromeAdd')}
      </Button>
    </fieldset>
  );
}

interface Props {
  storeId: string;
  kind: 'header' | 'footer';
  /** The draft's pending patch (`doc.chrome`). */
  chrome: DraftChrome | undefined;
  /** Changes when a publish/restore moved the live values, so they are re-read. */
  liveVersion: number | null;
  onChange: (patch: DraftChrome) => void;
}

export function ChromeContentPanel({ storeId, kind, chrome, liveVersion, onChange }: Props) {
  const t = useT('builder.settings');
  const locale = useLocale();
  const [live, setLive] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLive(null);
    setFailed(false);
    void apiGet<{ store: { settings?: Settings } }>(`/api/v1/stores/${storeId}`).then(r => {
      if (cancelled) return;
      if (r.error || !r.data) setFailed(true);
      else setLive(obj(r.data.store?.settings));
    });
    return () => {
      cancelled = true;
    };
  }, [storeId, liveVersion]);

  // Each edit sends ONLY the key it changed; the editor merges it into the
  // latest document, so two edits in one tick never drop each other.
  const current = chrome;
  const footer = (cols: Partial<NonNullable<DraftChrome['footerLinks']>>) =>
    onChange({ footerLinks: cols });
  const utility = (u: Partial<NonNullable<DraftChrome['utilityBar']>>) =>
    onChange({ utilityBar: u });

  if (failed)
    return (
      <p role="alert" className="text-xs text-destructive-ink">
        {t('chromeLoadFailed')}
      </p>
    );
  if (!live) return <p className="text-xs text-muted-foreground">{t('chromeLoading')}</p>;

  const liveFooter = obj(live.footerLinks);
  const liveUtility = obj(live.utilityBar);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div className="space-y-4" dir={dir} data-testid={`${kind}-chrome-content`}>
      <p className="rounded-lg border border-dashed border-border p-2 text-xs text-muted-foreground">
        {t(kind === 'header' ? 'headerContentNote' : 'footerContentNote')}
        {kind === 'header' && (
          <>
            {' · '}
            <a href={`/stores/${storeId}/branding`} className="text-primary hover:underline">
              {t('editInBranding')}
            </a>
          </>
        )}
      </p>

      {kind === 'header' && (
        <>
          <LinkList
            key={`nav-${liveVersion}`}
            title={t('chromeMenuTitle')}
            testId="chrome-nav"
            max={MAX_NAV_ITEMS}
            initial={
              current?.navMenu
                ? rowsFrom(current.navMenu, 'label', [])
                : rowsFrom(live.navMenu, 'label', fromDefaults(DEFAULT_MENU))
            }
            onCommit={rows => onChange({ navMenu: toStored(rows, 'label', false) as never })}
          />
          <div className="space-y-2">
            <label className="flex items-center justify-between text-sm">
              <span>{t('chromeUtilityEnabled')}</span>
              <Toggle
                checked={current?.utilityBar?.enabled ?? liveUtility.enabled !== false}
                onChange={on => utility({ enabled: on })}
                label={t('chromeUtilityEnabled')}
              />
            </label>
            <LinkList
              key={`utility-${liveVersion}`}
              title={t('chromeUtilityTitle')}
              testId="chrome-utility"
              max={MAX_UTILITY_LINKS}
              initial={
                current?.utilityBar?.links
                  ? rowsFrom(current.utilityBar.links, 'label', [])
                  : rowsFrom(liveUtility.links, 'label', fromDefaults(DEFAULT_UTILITY_LINKS))
              }
              onCommit={rows => utility({ links: toStored(rows, 'label') as never })}
            />
          </div>
        </>
      )}

      {kind === 'footer' && (
        <>
          {FOOTER_COLUMNS.map(col => (
            <LinkList
              key={`${col}-${liveVersion}`}
              title={t(`chromeFooter_${col}`)}
              testId={`chrome-footer-${col}`}
              max={MAX_FOOTER_LINKS_PER_COLUMN}
              initial={
                current?.footerLinks?.[col]
                  ? rowsFrom(current.footerLinks[col], 'name', [])
                  : rowsFrom(liveFooter[col], 'name', DEFAULT_COLUMNS[col])
              }
              onCommit={rows => footer({ [col]: toStored(rows, 'name') as never })}
            />
          ))}
          <label className="flex items-center justify-between text-sm">
            <span>{t('chromeNewsletter')}</span>
            <Toggle
              checked={
                current?.footerLinks?.newsletterEnabled ?? liveFooter.newsletterEnabled !== false
              }
              onChange={on => footer({ newsletterEnabled: on })}
              label={t('chromeNewsletter')}
            />
          </label>
        </>
      )}
    </div>
  );
}
