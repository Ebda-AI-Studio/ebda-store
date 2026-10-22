'use client';

/**
 * The section the pointer is over on the canvas. Canvas-only transient state: it lives in this tiny
 * store instead of `BuilderEditor` state, so a hover never re-renders the editor (tree, panes,
 * dialogs). Each tree row subscribes to a boolean ("am I the hovered one"), so only the two rows
 * whose highlight flips re-render.
 */
import { useSyncExternalStore } from 'react';

let hovered: string | null = null;
const listeners = new Set<() => void>();

export function setCanvasHover(id: string | null): void {
  if (id === hovered) return;
  hovered = id;
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useIsCanvasHovered(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hovered === id,
    () => false
  );
}
