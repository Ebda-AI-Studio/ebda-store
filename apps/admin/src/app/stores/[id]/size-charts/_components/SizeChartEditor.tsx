'use client';

/**
 * SizeChartEditor: one size chart as a grid the merchant edits in place.
 *
 * Arabic first: every column header has an Arabic and an English input (Arabic first), rows are
 * plain cell inputs, and columns/rows are added or removed within the shared limits. Three
 * templates fill the grid; a unit toggle (cm / in) and a live preview of the storefront dialog
 * sit under it. Controlled by its parent page, which owns the POST/PUT (one writer).
 */

import { useState } from 'react';
import { Input } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import {
  SIZE_CHART_CELL_MAX,
  SIZE_CHART_MAX_COLUMNS,
  SIZE_CHART_MAX_ROWS,
  sizeChartColumnLabel,
  sizeChartName,
  sizeChartNote,
  type SizeChart,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { useLocale } from 'next-intl';

export type SizeChartDraft = SizeChart;

export const EMPTY_SIZE_CHART: SizeChartDraft = {
  name: '',
  nameAr: '',
  unit: 'cm',
  columns: [
    { label: 'Size', labelAr: 'المقاس' },
    { label: '', labelAr: '' },
  ],
  rows: [['', '']],
  note: '',
  noteAr: '',
};

type TemplateKey = 'templateAbaya' | 'templateClothing' | 'templateRing';

/** Starting points. Digits are Latin (admin NUMERALS-1); values are typical, the merchant edits them. */
export const SIZE_CHART_TEMPLATES: Record<TemplateKey, SizeChartDraft> = {
  // Gulf/Egyptian abaya size = length in inches; the length column gives it in cm.
  templateAbaya: {
    name: 'Abaya',
    nameAr: 'عباية',
    unit: 'cm',
    columns: [
      { label: 'Size', labelAr: 'المقاس' },
      { label: 'Length', labelAr: 'الطول' },
    ],
    rows: [
      ['52', '132'],
      ['54', '137'],
      ['56', '142'],
      ['58', '147'],
      ['60', '152'],
    ],
    // The size numbers are inches while the caption reads cm: say so in one line.
    note: 'Abaya size = its length in inches',
    noteAr: 'رقم المقاس هو طول العباية بالبوصة',
  },
  templateClothing: {
    name: 'Clothing',
    nameAr: 'ملابس',
    unit: 'cm',
    columns: [
      { label: 'Size', labelAr: 'المقاس' },
      { label: 'Chest', labelAr: 'الصدر' },
      { label: 'Waist', labelAr: 'الوسط' },
      { label: 'Length', labelAr: 'الطول' },
    ],
    rows: [
      ['S', '92', '76', '68'],
      ['M', '98', '82', '70'],
      ['L', '104', '88', '72'],
      ['XL', '110', '94', '74'],
      ['XXL', '116', '100', '76'],
    ],
    note: 'Body measurements',
    noteAr: 'قياسات الجسم',
  },
  // EU ring size = inner circumference in mm; shown here in cm.
  templateRing: {
    name: 'Ring size',
    nameAr: 'مقاس الخاتم',
    unit: 'cm',
    columns: [
      { label: 'Size', labelAr: 'المقاس' },
      { label: 'Diameter', labelAr: 'القطر' },
      { label: 'Circumference', labelAr: 'المحيط' },
    ],
    rows: [
      ['48', '1.53', '4.8'],
      ['50', '1.59', '5.0'],
      ['52', '1.66', '5.2'],
      ['54', '1.72', '5.4'],
      ['56', '1.78', '5.6'],
      ['58', '1.85', '5.8'],
      ['60', '1.91', '6.0'],
    ],
    note: '',
    noteAr: '',
  },
};

const TEMPLATE_KEYS = Object.keys(SIZE_CHART_TEMPLATES) as TemplateKey[];

/** Grid helpers (pure, exported for tests). */
export function addColumn(c: SizeChartDraft): SizeChartDraft {
  if (c.columns.length >= SIZE_CHART_MAX_COLUMNS) return c;
  return {
    ...c,
    columns: [...c.columns, { label: '', labelAr: '' }],
    rows: c.rows.map(r => [...r, '']),
  };
}
export function removeColumn(c: SizeChartDraft, i: number): SizeChartDraft {
  if (c.columns.length <= 2) return c;
  return {
    ...c,
    columns: c.columns.filter((_, j) => j !== i),
    rows: c.rows.map(r => r.filter((_, j) => j !== i)),
  };
}
export function addRow(c: SizeChartDraft): SizeChartDraft {
  if (c.rows.length >= SIZE_CHART_MAX_ROWS) return c;
  return { ...c, rows: [...c.rows, c.columns.map(() => '')] };
}
export function removeRow(c: SizeChartDraft, i: number): SizeChartDraft {
  if (c.rows.length <= 1) return c;
  return { ...c, rows: c.rows.filter((_, j) => j !== i) };
}

const cellClass =
  'h-9 w-full min-w-[4.5rem] rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function RemoveButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-destructive-ink"
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
      </svg>
    </Button>
  );
}

/** The storefront dialog's table, in miniature: caption with unit, sticky first column. */
function Preview({ chart, lang }: { chart: SizeChartDraft; lang: 'ar' | 'en' }) {
  const unitText =
    lang === 'ar'
      ? chart.unit === 'in'
        ? 'القياسات بالبوصة'
        : 'القياسات بالسنتيمتر'
      : chart.unit === 'in'
        ? 'Measurements in inches'
        : 'Measurements in cm';
  const note = sizeChartNote(chart, lang);
  return (
    <div
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      lang={lang}
      className="rounded-lg border bg-background p-4"
    >
      <p className="text-base font-semibold text-foreground">{sizeChartName(chart, lang) || '—'}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="caption-bottom pt-2 text-start text-xs text-muted-foreground">
            {unitText}
          </caption>
          <thead>
            <tr>
              {chart.columns.map((col, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`border-b px-3 py-2 text-start font-medium text-muted-foreground ${i === 0 ? 'sticky start-0 bg-background' : ''}`}
                >
                  {sizeChartColumnLabel(col, lang)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.rows.map((row, r) => (
              <tr key={r} className="border-b last:border-0">
                {row.map((cell, i) =>
                  i === 0 ? (
                    <th
                      key={i}
                      scope="row"
                      className="sticky start-0 bg-background px-3 py-2 text-start font-medium text-foreground"
                    >
                      {cell}
                    </th>
                  ) : (
                    <td key={i} className="px-3 py-2 tabular-nums text-foreground">
                      {cell}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="mt-3 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

interface Props {
  value: SizeChartDraft;
  onChange: (next: SizeChartDraft) => void;
  isNew: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}

export function SizeChartEditor({
  value: c,
  onChange,
  isNew,
  saving,
  error,
  onSave,
  onCancel,
}: Props) {
  const t = useT('sizeCharts.editor');
  const askConfirm = useConfirm();
  const locale = useLocale();
  const [previewLang, setPreviewLang] = useState<'ar' | 'en'>(locale === 'en' ? 'en' : 'ar');
  const [dirty, setDirty] = useState(false);

  const update = (next: SizeChartDraft) => {
    setDirty(true);
    onChange(next);
  };
  const setColumn = (i: number, key: 'label' | 'labelAr', v: string) =>
    update({ ...c, columns: c.columns.map((col, j) => (j === i ? { ...col, [key]: v } : col)) });
  const setCell = (r: number, i: number, v: string) =>
    update({
      ...c,
      rows: c.rows.map((row, j) => (j === r ? row.map((x, k) => (k === i ? v : x)) : row)),
    });

  const applyTemplate = async (key: TemplateKey) => {
    if (
      dirty &&
      !(await askConfirm({
        object: t('templateReplaceObject'),
        consequence: t('templateReplace'),
        confirmLabel: t('templateReplaceLabel'),
        tone: 'default',
      }))
    )
      return;
    onChange(structuredClone(SIZE_CHART_TEMPLATES[key]));
    setDirty(false);
  };

  return (
    <section className="rounded-md border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground">
        {isNew ? t('createTitle') : t('editTitle')}
      </h2>

      <div className="mt-4">
        <p className="mb-2 text-sm font-medium text-foreground">{t('templates')}</p>
        <div className="flex flex-wrap gap-2">
          {TEMPLATE_KEYS.map(key => (
            <Button
              key={key}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyTemplate(key)}
            >
              {t(key)}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Input
          label={t('nameAr')}
          dir="rtl"
          lang="ar"
          maxLength={60}
          value={c.nameAr}
          onChange={e => update({ ...c, nameAr: e.target.value })}
        />
        <Input
          label={t('nameEn')}
          dir="ltr"
          maxLength={60}
          value={c.name}
          onChange={e => update({ ...c, name: e.target.value })}
        />
      </div>

      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium text-foreground">{t('unit')}</legend>
        <div
          role="radiogroup"
          aria-label={t('unit')}
          className="inline-flex rounded-md border border-input p-0.5"
        >
          {(['cm', 'in'] as const).map(u => (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={c.unit === u}
              onClick={() => update({ ...c, unit: u })}
              className={`h-9 min-w-[4rem] rounded-md px-3 text-sm ${c.unit === u ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {u === 'cm' ? t('unitCm') : t('unitIn')}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-6">
        <p className="text-sm font-medium text-foreground">{t('table')}</p>
        <p className="mb-2 text-xs text-muted-foreground">
          {t('tableHint', {
            columns: SIZE_CHART_MAX_COLUMNS,
            rows: SIZE_CHART_MAX_ROWS,
            cell: SIZE_CHART_CELL_MAX,
          })}
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="border-collapse text-sm">
            <thead className="bg-muted/40">
              <tr>
                {c.columns.map((col, i) => (
                  <th key={i} scope="col" className="min-w-[8.5rem] p-2 align-top font-normal">
                    <div className="mb-1 flex items-center justify-between gap-1">
                      <span className="text-xs text-muted-foreground">
                        {t('column', { n: i + 1 })}
                      </span>
                      <RemoveButton
                        label={t('removeColumn', { n: i + 1 })}
                        disabled={c.columns.length <= 2}
                        onClick={() => update(removeColumn(c, i))}
                      />
                    </div>
                    <input
                      aria-label={`${t('headerAr')} ${i + 1}`}
                      placeholder={t('headerAr')}
                      dir="rtl"
                      lang="ar"
                      maxLength={SIZE_CHART_CELL_MAX}
                      value={col.labelAr}
                      onChange={e => setColumn(i, 'labelAr', e.target.value)}
                      className={cellClass}
                    />
                    <input
                      aria-label={`${t('headerEn')} ${i + 1}`}
                      placeholder={t('headerEn')}
                      dir="ltr"
                      maxLength={SIZE_CHART_CELL_MAX}
                      value={col.label}
                      onChange={e => setColumn(i, 'label', e.target.value)}
                      className={`${cellClass} mt-1`}
                    />
                  </th>
                ))}
                <th className="w-10 p-2" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {c.rows.map((row, r) => (
                <tr key={r} className="border-t">
                  {row.map((cell, i) => (
                    <td key={i} className="p-2">
                      <input
                        aria-label={`${t('row', { n: r + 1 })}, ${t('column', { n: i + 1 })}`}
                        maxLength={SIZE_CHART_CELL_MAX}
                        value={cell}
                        onChange={e => setCell(r, i, e.target.value)}
                        className={cellClass}
                      />
                    </td>
                  ))}
                  <td className="p-2">
                    <RemoveButton
                      label={t('removeRow', { n: r + 1 })}
                      disabled={c.rows.length <= 1}
                      onClick={() => update(removeRow(c, r))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={c.rows.length >= SIZE_CHART_MAX_ROWS}
            onClick={() => update(addRow(c))}
          >
            {t('addRow')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={c.columns.length >= SIZE_CHART_MAX_COLUMNS}
            onClick={() => update(addColumn(c))}
          >
            {t('addColumn')}
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Input
          label={t('noteAr')}
          dir="rtl"
          lang="ar"
          maxLength={300}
          placeholder={t('notePlaceholder')}
          value={c.noteAr}
          onChange={e => update({ ...c, noteAr: e.target.value })}
        />
        <Input
          label={t('noteEn')}
          dir="ltr"
          maxLength={300}
          value={c.note}
          onChange={e => update({ ...c, note: e.target.value })}
        />
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">{t('preview')}</p>
          <div
            role="radiogroup"
            aria-label={t('previewLanguage')}
            className="inline-flex rounded-md border border-input p-0.5 text-xs"
          >
            {(['ar', 'en'] as const).map(l => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={previewLang === l}
                onClick={() => setPreviewLang(l)}
                className={`h-7 rounded-md px-2 ${previewLang === l ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {l === 'ar' ? t('previewAr') : t('previewEn')}
              </button>
            ))}
          </div>
        </div>
        <Preview chart={c} lang={previewLang} />
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive-ink">
          {error}
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="button" onClick={onSave} isLoading={saving}>
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </section>
  );
}
