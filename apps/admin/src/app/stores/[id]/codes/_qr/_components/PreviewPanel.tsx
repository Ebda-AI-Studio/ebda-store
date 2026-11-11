'use client';

import { buttonVariants } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/useT';
import { sceneToSvg, type Scene, type SelfCheck } from '@ebda/shared/qr';
import {
  buildPdf,
  canvasToBlob,
  canvasToRgb,
  compressDeflate,
  decodeCanvas,
  fileStem,
  renderToCanvas,
  triggerDownload,
} from '../../../../../../lib/qr-export';
import { Segmented } from './Segmented';

type Props = {
  scene: Scene | null;
  payload: string | null;
  check: SelfCheck | null;
  logo: { dataUrl: string; image: HTMLImageElement } | null;
  nameForFile: string;
};

const PNG_SIZES = ['512', '1024', '2048'] as const;
const PRINT_CM = ['5', '10', '15', '20'] as const;

export function PreviewPanel({ scene, payload, check, logo, nameForFile }: Props) {
  const t = useT('qr.preview');
  const td = useT('qr.download');
  const tt = useT('qr.target');
  const ref = useRef<HTMLCanvasElement>(null);
  const [pngSize, setPngSize] = useState<(typeof PNG_SIZES)[number]>('1024');
  const [printCm, setPrintCm] = useState<(typeof PRINT_CM)[number]>('10');
  const [busy, setBusy] = useState<null | 'png' | 'svg' | 'pdf'>(null);
  const [error, setError] = useState(false);

  // The preview is drawn by the same renderer that makes the PNG, so what you see is what prints.
  useEffect(() => {
    const target = ref.current;
    if (!target || !scene) return;
    const c = renderToCanvas(scene, 640, logo?.image);
    target.width = c.width;
    target.height = c.height;
    target.getContext('2d')?.drawImage(c, 0, 0);
  }, [scene, logo]);

  const ok = !!(scene && payload && check?.ok);
  const stem = fileStem(nameForFile);

  /** Render, decode the real pixels, and only then hand the file over. */
  async function produce(kind: 'png' | 'svg' | 'pdf') {
    if (!scene || !payload || !ok) return;
    setBusy(kind);
    setError(false);
    try {
      if (kind === 'svg') {
        const svg = sceneToSvg(scene, logo?.dataUrl);
        triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), `${stem}.svg`);
        return;
      }
      const widthPx = kind === 'png' ? Number(pngSize) : Math.round((Number(printCm) / 2.54) * 300);
      const canvas = renderToCanvas(scene, widthPx, logo?.image);
      if (decodeCanvas(canvas, scene) !== payload) {
        setError(true);
        return;
      }
      if (kind === 'png') {
        triggerDownload(await canvasToBlob(canvas), `${stem}.png`);
      } else {
        const deflatedRgb = await compressDeflate(canvasToRgb(canvas));
        const bytes = buildPdf({
          widthPx: canvas.width,
          heightPx: canvas.height,
          deflatedRgb,
          printWidthMm: Number(printCm) * 10,
          marginMm: 5,
          title: stem,
        });
        triggerDownload(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${stem}.pdf`);
      }
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  const btn = buttonVariants({ variant: 'outline' });

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      <div className="flex min-h-[16rem] items-center justify-center rounded-xl border border-border bg-muted/50 p-4">
        {scene ? (
          <canvas
            ref={ref}
            role="img"
            aria-label={t('alt')}
            className="h-auto w-full max-w-[17rem] rounded-md"
          />
        ) : (
          <p className="text-sm text-muted-foreground">{tt('pickFirst')}</p>
        )}
      </div>

      <p
        role="status"
        aria-live="polite"
        className={
          !check
            ? 'text-sm text-muted-foreground'
            : ok
              ? 'text-sm font-medium text-success-ink'
              : 'text-sm font-medium text-destructive-ink'
        }
      >
        {!check ? t('checking') : check.ok ? t('scanOk') : t('scanFail')}
      </p>

      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-foreground">{td('title')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btn}
            disabled={!ok || !!busy}
            onClick={() => produce('png')}
          >
            {td('png')}
          </button>
          <Segmented
            label={td('pngSize')}
            value={pngSize}
            onChange={setPngSize}
            options={PNG_SIZES.map(v => ({ value: v, label: v }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btn}
            disabled={!ok || !!busy}
            onClick={() => produce('pdf')}
          >
            {td('pdf')}
          </button>
          <Segmented
            label={td('printSize')}
            value={printCm}
            onChange={setPrintCm}
            options={PRINT_CM.map(v => ({ value: v, label: td('cm', { n: v }) }))}
          />
        </div>
        <div>
          <button
            type="button"
            className={btn}
            disabled={!ok || !!busy}
            onClick={() => produce('svg')}
          >
            {td('svg')}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{ok ? td('pdfNote') : td('blocked')}</p>
        {error && (
          <p role="alert" className="text-sm text-destructive-ink">
            {td('error')}
          </p>
        )}
      </div>
    </div>
  );
}
