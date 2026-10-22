/**
 * Keyboard path on the canvas (Task 13), the DOM-free and DOM-light parts: which element Tab goes
 * to next, and which elements form the selected target's cycle.
 */
import type { CanvasTarget } from './overlay-logic';

/** Next index when cycling `len` targets from `current` (-1 = none focused). Wraps both ways. */
export function cycleIndex(len: number, current: number, backwards: boolean): number {
  if (len <= 0) return -1;
  if (current < 0) return backwards ? len - 1 : 0;
  return (current + (backwards ? len - 1 : 1)) % len;
}

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);

/**
 * The cycle for the selected target, in reading order: its editable texts, then its "change image"
 * buttons, then its toolbar buttons. Hidden or disabled ones are skipped.
 */
export function cycleTargets(
  target: CanvasTarget | null,
  root: ParentNode = document
): HTMLElement[] {
  if (!target) return [];
  const section = root.querySelector(`[data-builder-id="${esc(target.sectionId)}"]`);
  const scopes: Element[] = [];
  if (section) {
    if (target.blockId)
      scopes.push(...section.querySelectorAll(`[data-builder-block="${esc(target.blockId)}"]`));
    else scopes.push(section);
  }
  const texts: HTMLElement[] = [];
  for (const scope of scopes)
    for (const el of scope.querySelectorAll<HTMLElement>('[data-builder-setting]'))
      if (!texts.includes(el)) texts.push(el);
  const images = Array.from(root.querySelectorAll<HTMLElement>('[data-builder-change-image]'));
  const tools = Array.from(
    root.querySelectorAll<HTMLElement>('[data-builder-toolbar-root] button:not([disabled])')
  );
  return [...texts, ...images, ...tools];
}

/** Make a plain text target focusable from script (not a Tab stop of the storefront itself). */
export function focusTarget(el: HTMLElement): void {
  if (!el.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT)$/.test(el.tagName))
    el.setAttribute('tabindex', '-1');
  el.focus();
}
