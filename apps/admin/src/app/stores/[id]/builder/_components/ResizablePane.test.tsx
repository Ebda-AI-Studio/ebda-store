// @vitest-environment jsdom
/**
 * Resizable side panes (Ahmad 2026-11-15): keyboard resize stays inside the bounds, double click resets, the
 * remembered width is restored, and the handle sits on the pane's inner edge in both directions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ResizablePane } from './ResizablePane';
import { PANE_BOUNDS, clampPaneWidth, readPaneWidth } from '../_lib/pane-width';

beforeEach(() => {
  // A real Storage stand-in: the host node's experimental localStorage is not a usable one under jsdom.
  const m = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    },
  });
});
afterEach(cleanup);

const mount = (side: 'start' | 'end', dir: 'ltr' | 'rtl' = 'ltr') =>
  render(
    <div dir={dir}>
      <ResizablePane
        side={side}
        storageKey={side}
        {...PANE_BOUNDS[side]}
        label={`resize ${side}`}
        className=""
      >
        <p>content</p>
      </ResizablePane>
    </div>
  );
const handle = (side: string) => screen.getByTestId(`pane-resizer-${side}`);
const now = (side: string) => Number(handle(side).getAttribute('aria-valuenow'));

describe('ResizablePane', () => {
  it('is an accessible vertical separator with its bounds', () => {
    mount('start');
    const h = handle('start');
    expect(h.getAttribute('role')).toBe('separator');
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect(h.getAttribute('aria-valuemin')).toBe('280');
    expect(h.getAttribute('aria-valuemax')).toBe('480');
    expect(now('start')).toBe(320);
  });

  it('resizes by 16px with the arrows, and Home / End jump to the bounds, never past them', () => {
    mount('start');
    fireEvent.keyDown(handle('start'), { key: 'ArrowRight' });
    expect(now('start')).toBe(336);
    fireEvent.keyDown(handle('start'), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle('start'), { key: 'ArrowLeft' });
    expect(now('start')).toBe(304);
    fireEvent.keyDown(handle('start'), { key: 'Home' });
    expect(now('start')).toBe(280);
    fireEvent.keyDown(handle('start'), { key: 'ArrowLeft' });
    expect(now('start')).toBe(280);
    fireEvent.keyDown(handle('start'), { key: 'End' });
    expect(now('start')).toBe(480);
    fireEvent.keyDown(handle('start'), { key: 'ArrowRight' });
    expect(now('start')).toBe(480);
  });

  it('the end pane grows toward the start in LTR and the keys mirror in RTL', () => {
    mount('end');
    fireEvent.keyDown(handle('end'), { key: 'ArrowLeft' });
    expect(now('end')).toBe(376);
    cleanup();
    window.localStorage.clear();
    mount('end', 'rtl');
    fireEvent.keyDown(handle('end'), { key: 'ArrowRight' });
    expect(now('end')).toBe(376);
    cleanup();
    window.localStorage.clear();
    mount('start', 'rtl');
    fireEvent.keyDown(handle('start'), { key: 'ArrowLeft' });
    expect(now('start')).toBe(336);
  });

  it('double click resets to the default and forgets the saved width', () => {
    mount('start');
    fireEvent.keyDown(handle('start'), { key: 'End' });
    expect(readPaneWidth('start')).toBe(480);
    fireEvent.doubleClick(handle('start'));
    expect(now('start')).toBe(320);
    expect(readPaneWidth('start')).toBeNull();
  });

  it('restores the remembered width per pane, clamped to the bounds', () => {
    window.localStorage.setItem('ebda.builder.pane.start', '400');
    window.localStorage.setItem('ebda.builder.pane.end', '9999');
    mount('start');
    expect(now('start')).toBe(400);
    cleanup();
    mount('end');
    expect(now('end')).toBe(520);
  });

  it('puts the handle on the inner edge (logical classes, so it mirrors in RTL)', () => {
    mount('start');
    expect(handle('start').className).toContain('-end-1');
    cleanup();
    mount('end');
    expect(handle('end').className).toContain('-start-1');
  });

  it('a pointer drag commits the dragged width once, on release', () => {
    mount('start');
    const h = handle('start');
    fireEvent.pointerDown(h, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(h, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(h, { clientX: 150, pointerId: 1 });
    expect(now('start')).toBe(370);
    expect(readPaneWidth('start')).toBe(370);
  });
});

describe('clampPaneWidth', () => {
  it('lets the canvas minimum lower the ceiling, but the pane minimum always wins', () => {
    expect(clampPaneWidth(500, 280, 480)).toBe(480);
    expect(clampPaneWidth(450, 280, 480, 350)).toBe(350);
    expect(clampPaneWidth(450, 280, 480, 100)).toBe(280);
  });
});
