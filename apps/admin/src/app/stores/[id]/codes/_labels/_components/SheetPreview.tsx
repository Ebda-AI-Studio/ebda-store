'use client';

import { useEffect, useRef } from 'react';
import { A4_MM, sheetCell, type LabelPreset } from '@ebda/shared';

type Props = {
  preset: LabelPreset;
  label: HTMLCanvasElement | null;
  widthMm: number;
  heightMm: number;
  /** Copies shown (first page only). */
  count: number;
  alt: string;
};

/** First page of the A4 sheet (cells outlined, filled with the label) or a short stretch of roll. */
export function SheetPreview({ preset, label, widthMm, heightMm, count, alt }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--border')
      ? `hsl(${css.getPropertyValue('--border').trim()})`
      : '#d4d0c8';
    const pxPerMm = preset.kind === 'sheet' ? 1.6 : 3;
    const pageW = preset.kind === 'sheet' ? A4_MM.w : widthMm;
    const rollGap = 2;
    const pageH =
      preset.kind === 'sheet' ? A4_MM.h : Math.min(3, Math.max(1, count)) * (heightMm + rollGap);
    c.width = Math.round(pageW * pxPerMm);
    c.height = Math.round(pageH * pxPerMm);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    const draw = (x: number, y: number) => {
      if (label)
        ctx.drawImage(label, x * pxPerMm, y * pxPerMm, widthMm * pxPerMm, heightMm * pxPerMm);
      ctx.strokeRect(x * pxPerMm, y * pxPerMm, widthMm * pxPerMm, heightMm * pxPerMm);
    };
    if (preset.kind === 'sheet') {
      const perPage = preset.cols! * preset.rows!;
      for (let i = 0; i < perPage; i++) {
        const cell = sheetCell(preset, i);
        if (i < count) draw(cell.x, cell.y);
        else {
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(cell.x * pxPerMm, cell.y * pxPerMm, widthMm * pxPerMm, heightMm * pxPerMm);
          ctx.setLineDash([]);
        }
      }
    } else {
      for (let i = 0; i < Math.min(3, Math.max(1, count)); i++) draw(0, i * (heightMm + rollGap));
    }
  }, [preset, label, widthMm, heightMm, count]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={alt}
      className="h-auto w-full max-w-[22rem] rounded-md border border-border bg-white"
    />
  );
}
