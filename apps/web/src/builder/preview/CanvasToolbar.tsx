'use client';

/**
 * The toolbar on the selected section or block (storefront side, inside the
 * builder canvas only): move up / down, duplicate, hide, remove, and for a
 * section a drag handle. Every button is a real, labelled `<button>`, so the
 * toolbar is also the keyboard path for these actions. It anchors at the
 * inline-end of the box and mirrors in Arabic. It only ASKS: each click posts
 * an intent and the admin parent decides (VE-2).
 */
import { BRAND, type SectionOp } from '@ebda/shared';

export type ToolbarLocale = 'en' | 'ar';

const COPY: Record<ToolbarLocale, Record<SectionOp | 'drag' | 'tools', string>> = {
  en: {
    moveUp: 'Move up',
    moveDown: 'Move down',
    duplicate: 'Duplicate',
    hide: 'Hide',
    remove: 'Remove',
    aiFill: 'Write with AI',
    drag: 'Drag to reorder',
    tools: 'Section tools',
  },
  ar: {
    moveUp: 'حرّك لفوق',
    moveDown: 'حرّك لتحت',
    duplicate: 'تكرار',
    hide: 'إخفاء',
    remove: 'حذف',
    aiFill: 'اكتب بالذكاء الاصطناعي',
    drag: 'اسحب لتغيير الترتيب',
    tools: 'أدوات القسم',
  },
};

const ICON: Record<SectionOp | 'drag', string> = {
  moveUp: 'M6 15l6-6 6 6',
  moveDown: 'M6 9l6 6 6-6',
  duplicate: 'M9 9h10v10H9zM5 15V5h10',
  hide: 'M3 3l18 18M10.6 6.2A9 9 0 0121 12a9 9 0 01-3 3.6M6.4 7.8A9 9 0 003 12a9 9 0 009 6 8.8 8.8 0 003.4-.7',
  remove: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  aiFill:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
};

export interface ToolbarProps {
  locale: ToolbarLocale;
  /** Page box of the selected target. */
  box: { top: number; left: number; width: number; height: number };
  pageWidth: number;
  /** False hides the drag handle (blocks cannot be dragged on the canvas). */
  draggable: boolean;
  disabled: Partial<Record<SectionOp, boolean>>;
  /** From the `md` breakpoint (768px) the glyphs carry a visible text label (Task 13). */
  labels?: boolean;
  /** The AI can write this section's kicker and subtitle: show the button. */
  ai?: boolean;
  onOp: (op: SectionOp) => void;
  onDragStart: (e: React.PointerEvent<HTMLButtonElement>) => void;
}

const SIZE = 36;
/** The drag handle's visible label is the first word of its accessible name (label in name). */
const SHORT_DRAG: Record<ToolbarLocale, string> = { en: 'Drag', ar: 'اسحب' };

export function CanvasToolbar({
  locale,
  box,
  pageWidth,
  draggable,
  disabled,
  ai,
  labels = false,
  onOp,
  onDragStart,
}: ToolbarProps) {
  const rtl = locale === 'ar';
  const copy = COPY[locale];
  const ops: SectionOp[] = [
    ...(ai ? (['aiFill'] as const) : []),
    'moveUp',
    'moveDown',
    'duplicate',
    'hide',
    'remove',
  ];
  // On the box's top edge, at its inline-end; inside the box when there is no room above.
  const top = box.top >= SIZE + 8 ? box.top - SIZE - 4 : box.top + 4;
  const end = rtl ? box.left + 4 : Math.max(0, pageWidth - (box.left + box.width)) + 4;
  const button = (
    key: SectionOp | 'drag',
    extra: React.ButtonHTMLAttributes<HTMLButtonElement>
  ) => (
    <button
      key={key}
      type="button"
      aria-label={copy[key]}
      title={copy[key]}
      data-builder-toolbar={key}
      style={{
        ...(labels
          ? { minWidth: SIZE, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 6 }
          : { width: SIZE, display: 'grid', placeItems: 'center' }),
        height: SIZE,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: '#ffffff',
        cursor: extra.disabled ? 'not-allowed' : key === 'drag' ? 'grab' : 'pointer',
        opacity: extra.disabled ? 0.35 : 1,
        touchAction: key === 'drag' ? 'none' : undefined,
      }}
      {...extra}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={key === 'drag' ? 3 : 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={ICON[key]} />
      </svg>
      {labels && <span>{key === 'drag' ? SHORT_DRAG[locale] : copy[key]}</span>}
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label={copy.tools}
      data-builder-toolbar-root
      dir={rtl ? 'rtl' : 'ltr'}
      style={{
        position: 'absolute',
        top,
        insetInlineEnd: end,
        zIndex: 2147483003,
        display: 'flex',
        flexWrap: 'wrap',
        maxWidth: Math.max(160, pageWidth - 16),
        gap: 2,
        padding: 2,
        borderRadius: 8,
        background: '#1c1917',
        border: `1px solid ${BRAND.colors.gold}`,
      }}
    >
      {draggable && button('drag', { onPointerDown: onDragStart })}
      {ops.map(op => button(op, { disabled: disabled[op], onClick: () => onOp(op) }))}
    </div>
  );
}
