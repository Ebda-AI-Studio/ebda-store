'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { LABEL_PRESETS, layoutLabel } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import {
  canvasToRgb,
  compressDeflate,
  triggerDownload,
  fileStem,
} from '../../../../../lib/qr-export';
import {
  buildPagesPdf,
  checkLabelCanvas,
  planPages,
  renderLabelCanvas,
  type LabelCheck,
} from '../../../../../lib/label-export';
import { Segmented } from '../_qr/_components/Segmented';
import { ShapePicker } from './_components/ShapePicker';
import { SheetPreview } from './_components/SheetPreview';
import { toLabelItem, useLabels } from './useLabels';
import { Button, buttonVariants } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';

const MAX_TOTAL_COPIES = 2000;

type Status = 'checking' | 'ok' | 'notPrintable' | 'unreadable';

export function LabelsTab({ storeId }: { storeId: string }) {
  const t = useT('labels');
  const ti = useT('labels.items');
  const tc = useT('labels.content');
  const tp = useT('labels.preview');
  const ta = useT('labels.actions');
  const locale = useLocale();
  const L = useLabels(storeId);
  const { settings, setSettings, layout, preset } = L;

  const [labelCanvas, setLabelCanvas] = useState<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<Status>('checking');
  const shown = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState<null | 'pdf' | 'print'>(null);
  const [outError, setOutError] = useState<string | null>(null);

  // Render the previewed label with the SAME renderer the PDF uses, then read its barcode back.
  useEffect(() => {
    let alive = true;
    setStatus('checking');
    renderLabelCanvas({ layout, qrScene: L.qrScene })
      .then(c => {
        if (!alive) return;
        setLabelCanvas(c);
        const r: LabelCheck = checkLabelCanvas(c, layout);
        setStatus(r.ok ? 'ok' : r.reason === 'not-printable' ? 'notPrintable' : 'unreadable');
      })
      .catch(() => alive && setStatus('unreadable'));
    return () => {
      alive = false;
    };
  }, [layout, L.qrScene]);

  useEffect(() => {
    const el = shown.current;
    if (!el || !labelCanvas) return;
    el.width = labelCanvas.width;
    el.height = labelCanvas.height;
    el.getContext('2d')?.drawImage(labelCanvas, 0, 0);
  }, [labelCanvas]);

  const printable = L.chosen.filter(c => c.item.barcode);
  const missing = L.chosen.length - printable.length;
  const totalCopies = printable.reduce((n, c) => n + c.qty, 0);
  const perPage = preset.kind === 'sheet' ? preset.cols! * preset.rows! : 1;
  const pageCount =
    preset.kind === 'sheet' ? Math.max(1, Math.ceil(totalCopies / perPage)) : totalCopies;
  const overCap = totalCopies > MAX_TOTAL_COPIES;
  const canOutput = status === 'ok' && printable.length > 0 && !busy && !overCap;

  async function produce(mode: 'pdf' | 'print') {
    setBusy(mode);
    setOutError(null);
    try {
      const images = [];
      const labels = [];
      const failed: string[] = [];
      for (const c of printable) {
        const li = toLabelItem(c.item)!;
        const lay = layoutLabel(preset, li, settings);
        const canvas = await renderLabelCanvas({ layout: lay, qrScene: L.qrScene });
        // every label is read back from its own pixels before any file is produced
        if (!checkLabelCanvas(canvas, lay).ok) {
          failed.push(li.nameAr && locale === 'ar' ? li.nameAr : li.name);
          continue;
        }
        images.push({
          widthPx: canvas.width,
          heightPx: canvas.height,
          deflatedRgb: await compressDeflate(canvasToRgb(canvas)),
        });
        labels.push({
          image: images.length - 1,
          copies: c.qty,
          widthMm: lay.widthMm,
          heightMm: lay.heightMm,
        });
      }
      if (failed.length) {
        setOutError(
          ta('failedItems', { names: failed.slice(0, 3).join(locale === 'ar' ? '، ' : ', ') })
        );
        return;
      }
      const bytes = buildPagesPdf({
        images,
        pages: planPages(preset, labels),
        title: fileStem('labels'),
      });
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      if (mode === 'pdf') {
        triggerDownload(blob, `${fileStem('labels')}.pdf`);
      } else {
        // A blob PDF in a hidden iframe prints blank in Chrome/Firefox and has no viewer on iOS:
        // open it in its own tab (the browser's PDF viewer has Print) and fall back to a download.
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank');
        if (!w) triggerDownload(blob, `${fileStem('labels')}.pdf`);
        setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
      }
    } catch {
      setOutError(ta('downloadError'));
    } finally {
      setBusy(null);
    }
  }

  if (L.loading)
    return (
      <div className="flex h-64 items-center justify-center">
        <div
          role="status"
          aria-label={t('loading')}
          className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary"
        />
      </div>
    );
  if (L.loadError)
    return (
      <p role="alert" className="text-sm text-destructive-ink">
        {t('loadError')}
      </p>
    );

  const btn = buttonVariants({ variant: 'outline' });
  const set = (patch: Partial<typeof settings>) => setSettings({ ...settings, ...patch });
  const toggles = ['name', 'variant', 'price', 'digits', 'qr'] as const;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-6">
        <div className="space-y-6 rounded-md border border-border bg-card p-5 sm:p-6">
          <section className="space-y-3" aria-labelledby="lb-items">
            <h2 id="lb-items" className="text-base font-semibold text-foreground">
              {ti('title')}
            </h2>
            <input
              type="search"
              value={L.search}
              onChange={e => L.setSearch(e.target.value)}
              placeholder={ti('searchPlaceholder')}
              aria-label={ti('search')}
              className={FIELD_CLASSES}
            />
            {L.items.length === 0 && !L.itemsLoading ? (
              <p className="text-sm text-muted-foreground">{ti('empty')}</p>
            ) : (
              <ul className="max-h-72 divide-y divide-border overflow-auto rounded-lg border border-border">
                {L.items.map(i => {
                  const pick = L.selected[i.id];
                  const name = locale === 'ar' && i.nameAr ? i.nameAr : i.name;
                  const variant =
                    locale === 'ar' && i.variantTitleAr ? i.variantTitleAr : i.variantTitle;
                  return (
                    <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-primary"
                        checked={!!pick}
                        onChange={() => L.toggle(i)}
                        aria-label={`${name}${variant ? ` / ${variant}` : ''}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {name}
                        {variant && <span className="ms-2 text-muted-foreground">{variant}</span>}
                      </span>
                      {!i.barcode && (
                        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {ti('noBarcode')}
                        </span>
                      )}
                      {pick && (
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={pick.qty}
                          dir="ltr"
                          aria-label={`${ti('qty')}: ${name}${variant ? ` / ${variant}` : ''}`}
                          onChange={e => L.setQty(i.id, Number(e.target.value))}
                          className={`${FIELD_CLASSES} w-16 shrink-0 text-center`}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {L.nextCursor && (
              <button
                type="button"
                className={btn}
                onClick={() => void L.loadMore()}
                disabled={L.itemsLoading}
              >
                {ti('loadMore')}
              </button>
            )}
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">
              <span className="text-foreground">{ti('generateBody')}</span>
              <button
                type="button"
                className={btn}
                onClick={() => void L.generateMissing()}
                disabled={L.generating}
              >
                {L.generating ? ti('generating') : ti('generateButton')}
              </button>
              {L.generateError && (
                <span role="alert" className="text-destructive-ink">
                  {ti('generateError')}
                </span>
              )}
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-5" aria-labelledby="lb-shape">
            <h2 id="lb-shape" className="text-base font-semibold text-foreground">
              {t('shape.title')}
            </h2>
            <ShapePicker value={settings.shape} onChange={shape => set({ shape })} />
          </section>

          <section className="space-y-3 border-t border-border pt-5" aria-labelledby="lb-content">
            <h2 id="lb-content" className="text-base font-semibold text-foreground">
              {tc('title')}
            </h2>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {toggles.map(k => (
                <label key={k} className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-primary"
                    checked={settings.content[k]}
                    onChange={e => set({ content: { ...settings.content, [k]: e.target.checked } })}
                  />
                  {tc(k)}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">{tc('lang')}</span>
              <Segmented
                label={tc('lang')}
                value={settings.lang}
                onChange={lang => set({ lang })}
                options={[
                  { value: 'ar', label: tc('langAr') },
                  { value: 'en', label: tc('langEn') },
                ]}
              />
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-5" aria-labelledby="lb-size">
            <h2 id="lb-size" className="text-base font-semibold text-foreground">
              {t('size.title')}
            </h2>
            <select
              aria-label={t('size.title')}
              value={settings.preset}
              onChange={e => set({ preset: e.target.value })}
              className={FIELD_CLASSES}
            >
              <optgroup label={t('size.sheets')}>
                {LABEL_PRESETS.filter(p => p.kind === 'sheet').map(p => (
                  <option key={p.id} value={p.id}>
                    {t(`size.presets.${p.id}`)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('size.rolls')}>
                {LABEL_PRESETS.filter(p => p.kind === 'roll').map(p => (
                  <option key={p.id} value={p.id}>
                    {t(`size.presets.${p.id}`)}
                  </option>
                ))}
              </optgroup>
            </select>
          </section>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
            <Button
              variant="default"
              size="md"
              type="button"
              onClick={L.save}
              disabled={L.saving || !L.dirty || status === 'checking'}
            >
              {L.saving ? ta('saving') : ta('save')}
            </Button>
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {L.saveState === 'saved' && !L.dirty
                ? ta('saved')
                : L.saveState === 'error'
                  ? ta('saveError')
                  : L.dirty
                    ? ta('unsaved')
                    : ''}
            </p>
          </div>
        </div>
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        <div className="space-y-4 rounded-md border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">{tp('title')}</h2>
          <div className="flex min-h-[10rem] items-center justify-center rounded-md border border-border bg-muted/50 p-4">
            <canvas
              ref={shown}
              role="img"
              aria-label={tp('labelAlt')}
              className="h-auto w-full max-w-[18rem] rounded-sm bg-white shadow-sm"
            />
          </div>
          {L.isSample && <p className="text-xs text-muted-foreground">{tp('sampleNote')}</p>}

          <p
            role="status"
            aria-live="polite"
            className={
              status === 'checking'
                ? 'text-sm text-muted-foreground'
                : status === 'ok'
                  ? 'text-sm font-medium text-success-ink'
                  : 'text-sm font-medium text-destructive-ink'
            }
          >
            {tp(status)}
          </p>
          {layout.dropped.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {tp('dropped', {
                parts: layout.dropped.map(d => tc(d)).join(locale === 'ar' ? '، ' : ', '),
              })}
            </p>
          )}

          <h3 className="text-sm font-semibold text-foreground">{tp('sheet')}</h3>
          <SheetPreview
            preset={preset}
            label={labelCanvas}
            widthMm={layout.widthMm}
            heightMm={layout.heightMm}
            count={Math.max(1, Math.min(totalCopies || 1, perPage))}
            alt={tp('sheetAlt')}
          />
          <p className="text-xs text-muted-foreground">
            {printable.length
              ? tp('copies', { labels: totalCopies, pages: pageCount })
              : ti('pickFirst')}
            {missing > 0 ? ` ${ti('missingSkipped', { count: missing })}` : ''}
          </p>

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <button
              type="button"
              className={btn}
              disabled={!canOutput}
              onClick={() => void produce('pdf')}
            >
              {busy === 'pdf' ? ta('working') : ta('pdf')}
            </button>
            <button
              type="button"
              className={btn}
              disabled={!canOutput}
              onClick={() => void produce('print')}
            >
              {busy === 'print' ? ta('working') : ta('print')}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {status === 'ok' ? t('testNote') : ta('blocked')}
          </p>
          {overCap && (
            <p role="alert" className="text-sm text-destructive-ink">
              {ta('tooMany', { max: MAX_TOTAL_COPIES })}
            </p>
          )}
          {outError && (
            <p role="alert" className="text-sm text-destructive-ink">
              {outError}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
