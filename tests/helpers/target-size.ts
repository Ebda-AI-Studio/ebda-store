/**
 * Quality bar § 10 rule (d) (W4): a deterministic target-size check for jsdom renders, which have
 * no layout. The hit box is computed from the element's own Tailwind classes (Tailwind's spacing
 * scale: 1 = 4px), the way the browser will size it:
 *   height = h-* | size-* | min-h-*  (else py-* x2 + the text size's line height)
 *   width  = w-* | size-* | min-w-*  (else unknown: text-labelled controls are as wide as their words)
 *   width lower bounds: w-full/flex-1/grow fill the row, px-N spans 2N, a text input defaults to ~150px
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

/**
 * W5: the box at EVERY breakpoint, mobile first (base, then sm:, md:, lg:, xl: override in turn),
 * and the smallest one wins. The W4 reading dropped every `sm:`-prefixed class, so a field that is
 * `h-11 sm:h-10` passed here and measured 40px in the browser (a11y re-audit P2-N1). A breakpoint
 * where the element is `hidden` is skipped.
 */
const BREAKPOINTS = ['sm', 'md', 'lg', 'xl'];
export function hitBox(el: Element): { h: number | null; w: number | null } {
  const all = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const base = all.filter(c => !c.includes(':') || c.startsWith('before:'));
  const at = (bp: string) =>
    all.filter(c => c.startsWith(`${bp}:`)).map(c => c.slice(bp.length + 1));
  const stacks: string[][] = [base];
  let acc = base;
  for (const bp of BREAKPOINTS) {
    const add = at(bp);
    if (!add.length) continue;
    acc = [...acc, ...add];
    stacks.push(acc);
  }
  const shown = stacks.filter(cls => {
    const d = cls.filter(c => /^(hidden|block|flex|inline-flex|inline-block|grid|inline)$/.test(c));
    return d[d.length - 1] !== 'hidden';
  });
  const boxes = (shown.length ? shown : [base]).map(cls => boxFor(el, cls));
  const ws = boxes.map(b => b.w).filter((w): w is number => w !== null);
  return { h: Math.min(...boxes.map(b => b.h ?? 0)), w: ws.length ? Math.min(...ws) : null };
}

function boxFor(el: Element, cls: string[]): { h: number | null; w: number | null } {
  let h: number | null = null;
  let w: number | null = null;
  let minH = 0;
  let minW = 0;
  let py = 0;
  let px = 0;
  let fluid = false;
  let text = 20;
  let insetX = 0;
  let insetY = 0;
  for (const c of cls) {
    let m: RegExpExecArray | null;
    if (/^(w-full|flex-1|grow|flex-grow)$/.test(c)) fluid = true;
    else if ((m = /^h-(.+)$/.exec(c))) h = SCALE(m[1]) ?? h;
    else if ((m = /^w-(.+)$/.exec(c))) w = SCALE(m[1]) ?? w;
    else if ((m = /^size-(.+)$/.exec(c))) h = w = SCALE(m[1]) ?? h;
    else if ((m = /^min-h-(.+)$/.exec(c))) minH = SCALE(m[1]) ?? minH;
    else if ((m = /^min-w-(.+)$/.exec(c))) minW = SCALE(m[1]) ?? minW;
    else if ((m = /^py-(.+)$/.exec(c))) py = SCALE(m[1]) ?? py;
    else if ((m = /^px-(.+)$/.exec(c))) px = SCALE(m[1]) ?? px;
    else if ((m = /^text-(xs|sm|base|lg|xl)$/.exec(c))) text = LINE[m[1]];
    // axis-specific insets first: the general pattern would swallow "y-3" and read 0
    else if ((m = /^before:-inset-y-(.+)$/.exec(c))) insetY = SCALE(m[1]) ?? 0;
    else if ((m = /^before:-inset-x-(.+)$/.exec(c))) insetX = SCALE(m[1]) ?? 0;
    else if ((m = /^before:-inset-(.+)$/.exec(c))) insetX = insetY = SCALE(m[1]) ?? 0;
  }
  const height = Math.max(h ?? py * 2 + text, minH) + insetY * 2;
  // Width lower bounds: a fluid control fills its row; padding alone already spans 2*px;
  // a text field with no width class gets the browser default (size=20, ~150px).
  const isTextField =
    el.tagName === 'INPUT' && !/^(checkbox|radio|range)$/.test(el.getAttribute('type') ?? '');
  const lower = fluid ? Infinity : Math.max(px * 2, isTextField && w === null ? 150 : 0);
  const known = w !== null || minW > 0 || lower > 0;
  const width = known ? Math.max(w ?? 0, minW, lower) + insetX * 2 : null;
  return { h: height, w: width };
}

/**
 * Every interactive element under `root` whose computed hit box is under `min` px.
 * `requireWidth`: a control whose width is unknown (a text link with no min-w) fails
 * too, for rows of short words ("FAQ", "عنّا") that measured 33-41px wide (a11y P2-10).
 */
export function smallTargets(
  root: ParentNode,
  min = 44,
  { requireWidth = false }: { requireWidth?: boolean } = {}
): string[] {
  return Array.from(
    root.querySelectorAll('a[href], button, [role="button"], select, input:not([type="hidden"])')
  )
    .filter(el => !(el as HTMLElement).hidden && el.getAttribute('aria-hidden') !== 'true')
    .map(el => ({ el, box: hitBox(el) }))
    .filter(({ box }) => (box.h ?? 0) < min || (box.w === null ? requireWidth : box.w < min))
    .map(
      ({ el, box }) =>
        `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${box.w ?? '?'}x${box.h}`
    );
}
