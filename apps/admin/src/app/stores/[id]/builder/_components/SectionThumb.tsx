/**
 * Schematic preview of a section preset for the "Add section" picker — a
 * wireframe in the Ebda palette (night + gold), not a screenshot: it shows
 * the shape the section will take (image side, columns, form) at a glance
 * and costs no network. Mirrors in RTL (logical `start`/`end`).
 */
import { BRAND } from '@ebda/shared';

const GOLD = BRAND.colors.gold;
const LIFT = BRAND.colors.lift;
const INK = 'currentColor';

export function SectionThumb({
  type,
  settings,
}: {
  type: string;
  settings: Record<string, unknown>;
}) {
  const box = (x: number, y: number, w: number, h: number, fill: string, op = 1) => (
    <rect x={x} y={y} width={w} height={h} rx={2} fill={fill} opacity={op} />
  );
  const line = (x: number, y: number, w: number) => box(x, y, w, 3, INK, 0.35);
  let body: React.ReactNode;
  switch (type) {
    case 'hero':
      body = (
        <>
          {box(4, 6, 112, 48, GOLD, 0.35)}
          {line(30, 24, 60)}
          {box(46, 34, 28, 8, GOLD)}
        </>
      );
      break;
    case 'image-text': {
      const imageStart = settings.imagePosition !== 'end';
      // logical start = left in the LTR wireframe; the dialog mirrors under dir=rtl
      const ix = imageStart ? 6 : 64;
      const tx = imageStart ? 64 : 6;
      body = (
        <>
          {box(ix, 8, 50, 44, GOLD, 0.35)}
          {line(tx, 16, 44)}
          {line(tx, 24, 36)}
          {line(tx, 30, 40)}
          {box(tx, 40, 20, 7, GOLD)}
        </>
      );
      break;
    }
    case 'newsletter':
      body = (
        <>
          {line(35, 14, 50)}
          {line(28, 22, 64)}
          {box(20, 32, 56, 10, INK, 0.12)}
          {box(80, 32, 20, 10, GOLD)}
        </>
      );
      break;
    case 'category-grid':
      body = [0, 1, 2].map(i => (
        <g key={i}>
          {box(10 + i * 36, 12, 28, 28, LIFT, 0.5)}
          {line(14 + i * 36, 44, 20)}
        </g>
      ));
      break;
    case 'new-arrivals':
    case 'best-sellers':
    case 'product-carousel':
      body = [0, 1, 2, 3].map(i => (
        <g key={i}>
          {box(6 + i * 28, 10, 24, 30, LIFT, 0.5)}
          {line(8 + i * 28, 44, 16)}
          {box(8 + i * 28, 50, 10, 3, GOLD)}
        </g>
      ));
      break;
    case 'testimonials':
      body = [0, 1].map(i => (
        <g key={i}>
          {box(8 + i * 54, 12, 50, 36, INK, 0.08)}
          {line(14 + i * 54, 22, 36)}
          {line(14 + i * 54, 30, 30)}
        </g>
      ));
      break;
    case 'trust-strip':
      body = [0, 1, 2].map(i => (
        <g key={i}>
          <circle cx={24 + i * 36} cy={26} r={8} fill={GOLD} opacity={0.6} />
          {line(14 + i * 36, 40, 20)}
        </g>
      ));
      break;
    // T7 signature sections
    case 'editorial-collage':
      body = (
        <>
          {box(14, 6, 46, 48, GOLD, 0.35)}
          {box(62, 8, 40, 26, GOLD, 0.55)}
          {box(58, 36, 34, 20, GOLD, 0.45)}
        </>
      );
      break;
    case 'piece-window':
      body = (
        <>
          <rect x={38} y={4} width={44} height={52} fill="none" stroke={GOLD} strokeWidth={1} />
          {box(42, 8, 36, 44, GOLD, 0.35)}
        </>
      );
      break;
    case 'spec-sheet':
      body = (
        <>
          {box(6, 8, 46, 44, GOLD, 0.3)}
          {[0, 1, 2, 3].map(i => (
            <g key={i}>
              {box(58 + (i % 2) * 30, 10 + Math.floor(i / 2) * 22, 26, 8, INK, 0.5)}
              {line(58 + (i % 2) * 30, 21 + Math.floor(i / 2) * 22, 18)}
            </g>
          ))}
        </>
      );
      break;
    case 'key-ingredients':
      body = (
        <>
          {box(6, 6, 38, 48, GOLD, 0.3)}
          {[0, 1, 2, 3].map(i => (
            <g key={i}>
              <circle cx={54} cy={13 + i * 12} r={2} fill={GOLD} />
              {line(60, 12 + i * 12, 46)}
            </g>
          ))}
        </>
      );
      break;
    case 'kitchen-days':
      body = [0, 1, 2, 3].map(i => (
        <g key={i}>
          {box(6 + i * 28, 12, 24, 36, INK, 0.08)}
          {box(9 + i * 28, 17, 12, 3, GOLD)}
          {line(9 + i * 28, 25, 18)}
        </g>
      ));
      break;
    default:
      body = (
        <>
          {line(20, 18, 80)}
          {line(20, 28, 64)}
          {line(20, 38, 72)}
        </>
      );
  }
  return (
    <svg
      viewBox="0 0 120 60"
      aria-hidden="true"
      className="block h-auto w-full rounded-lg bg-muted/50 text-foreground rtl:-scale-x-100"
    >
      {body}
    </svg>
  );
}
