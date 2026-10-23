import type { KeyboardEvent } from 'react';

/**
 * Arrow-key navigation for a row of tabs or radios (the WAI-ARIA pattern): Left / Right move to the
 * neighbour and activate it, Home / End jump to the ends, and only the active one is in the Tab
 * order (`tabIndex={active ? 0 : -1}` on the items). "Left" and "Right" follow the reading
 * direction, so in Arabic the Right arrow goes to the previous (visually right-hand) item.
 */
export function rovingKeyDown(e: KeyboardEvent<HTMLElement>, itemRole: 'tab' | 'radio') {
  const list = e.currentTarget;
  const items = Array.from(list.querySelectorAll<HTMLElement>(`[role="${itemRole}"]`)).filter(
    el => !(el as HTMLButtonElement).disabled
  );
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  const rtl = list.closest('[dir]')?.getAttribute('dir') === 'rtl';
  let to = -1;
  if (e.key === 'ArrowRight') to = at + (rtl ? -1 : 1);
  else if (e.key === 'ArrowLeft') to = at + (rtl ? 1 : -1);
  else if (e.key === 'ArrowDown') to = at + 1;
  else if (e.key === 'ArrowUp') to = at - 1;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = items.length - 1;
  else return;
  e.preventDefault();
  const next = items[(to + items.length) % items.length];
  next.focus();
  next.click();
}
