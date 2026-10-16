/**
 * Quality bar § 10 rule (d) (W4): a deterministic target-size check for jsdom renders, which have
 * no layout. The hit box is computed from the element's own Tailwind classes (Tailwind's spacing
 * scale: 1 = 4px), the way the browser will size it:
 *   height = h-* | size-* | min-h-*  (else py-* x2 + the text size's line height)
 *   width  = w-* | size-* | min-w-*  (else unknown: text-labelled controls are as wide as their words)
 *   a `before:` hit-area inset (before:-inset-N, before:-inset-y-N, before:-inset-x-N) adds to both.
 * Unknown dimensions are reported as null and only height is enforced for text controls.
 */
const SCALE = (v: string): number | null => {
  const arb = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(v);
  if (arb) return arb[2] === 'rem' ? +arb[1] * 16 : +arb[1];
  if (/^\d+(\.\d+)?$/.test(v)) return +v * 4;
  return null;
};
const LINE: Record<string, number> = { xs: 16, sm: 20, base: 24, lg: 28, xl: 28 };

export function hitBox(el: Element): { h: number | null; w: number | null } {
  const cls = (el.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter(c => !c.includes(':') || c.startsWith('before:'));
  let h: number | null = null;
  let w: number | null = null;
  let minH = 0;
  let minW = 0;
  let py = 0;
  let text = 20;
  let insetX = 0;
  let insetY = 0;
  for (const c of cls) {
    let m: RegExpExecArray | null;
    if ((m = /^h-(.+)$/.exec(c))) h = SCALE(m[1]) ?? h;
    else if ((m = /^w-(.+)$/.exec(c))) w = SCALE(m[1]) ?? w;
    else if ((m = /^size-(.+)$/.exec(c))) h = w = SCALE(m[1]) ?? h;
    else if ((m = /^min-h-(.+)$/.exec(c))) minH = SCALE(m[1]) ?? minH;
    else if ((m = /^min-w-(.+)$/.exec(c))) minW = SCALE(m[1]) ?? minW;
    else if ((m = /^py-(.+)$/.exec(c))) py = SCALE(m[1]) ?? py;
    else if ((m = /^text-(xs|sm|base|lg|xl)$/.exec(c))) text = LINE[m[1]];
    else if ((m = /^before:-inset-(.+)$/.exec(c))) insetX = insetY = SCALE(m[1]) ?? 0;
    else if ((m = /^before:-inset-y-(.+)$/.exec(c))) insetY = SCALE(m[1]) ?? 0;
    else if ((m = /^before:-inset-x-(.+)$/.exec(c))) insetX = SCALE(m[1]) ?? 0;
  }
  const height = Math.max(h ?? py * 2 + text, minH) + insetY * 2;
  const width = w !== null || minW ? Math.max(w ?? 0, minW) + insetX * 2 : null;
  return { h: height, w: width };
}

/** Every interactive element under `root` whose computed hit box is under `min` px. */
export function smallTargets(root: ParentNode, min = 44): string[] {
  return Array.from(
    root.querySelectorAll('a[href], button, [role="button"], select, input:not([type="hidden"])')
  )
    .filter(el => !(el as HTMLElement).hidden && el.getAttribute('aria-hidden') !== 'true')
    .map(el => ({ el, box: hitBox(el) }))
    .filter(({ box }) => (box.h ?? 0) < min || (box.w !== null && box.w < min))
    .map(
      ({ el, box }) =>
        `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${box.w ?? '?'}x${box.h}`
    );
}
