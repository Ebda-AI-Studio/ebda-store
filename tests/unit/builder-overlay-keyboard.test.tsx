// @vitest-environment jsdom
/**
 * Task 13: the keyboard path INSIDE the canvas (the shipped `EditorOverlay`): Tab / Shift+Tab cycle
 * the selected section's text, image and toolbar targets, Esc hands focus back to the tree, Alt+Arrow
 * moves the selection, Enter on a focused text edits it, a parent `focus` lands on the first target,
 * and the toolbar glyphs carry visible labels from `md` up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import {
  BUILDER_PROTOCOL,
  layoutToDefinition,
  resolveLayoutSettings,
  type PageDefinition,
} from '@ebda/shared';
import EditorOverlay from '../../apps/web/src/builder/preview/EditorOverlay';
import { cycleIndex } from '../../apps/web/src/builder/preview/keyboard-logic';

const ADMIN = 'https://admin.test';
const parent = { postMessage: vi.fn() };

const doc = (): PageDefinition =>
  layoutToDefinition(
    resolveLayoutSettings(
      {
        hero: { enabled: true, slides: [{ image: '/a.jpg' }, { image: '/b.jpg' }] },
        announcement: { enabled: true },
        header: {},
        footer: {},
      } as never,
      'modern'
    )
  );

function page(d: PageDefinition) {
  const hero = d.sections.find(n => n.type === 'hero')!;
  document.body.innerHTML = `
    <div data-zone="header"><nav id="nav">menu</nav></div>
    <main>
      <div data-builder-id="${hero.id}" style="display:contents">
        <section id="hero"><div id="s1" data-builder-block="slide-1" data-builder-image="image"><h1 id="t1" data-builder-setting="headline">A</h1></div>
        <div id="s2" data-builder-block="slide-2"><h1 id="t2" data-builder-setting="headline">B</h1></div></section>
      </div>
    </main>
    <div data-zone="footer"><footer id="foot">foot</footer></div>`;
  return hero.id;
}

beforeEach(() => {
  parent.postMessage.mockReset();
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s };
  Element.prototype.getBoundingClientRect = () =>
    ({ top: 100, left: 20, width: 300, height: 80, right: 320, bottom: 180 }) as DOMRect;
});
afterEach(cleanup);

const mount = (d: PageDefinition, locale: 'en' | 'ar' = 'en') =>
  render(
    <EditorOverlay allowedOrigins={[ADMIN]} locale={locale} definition={d} onRender={() => {}} />
  );
const posted = () => parent.postMessage.mock.calls.map(c => c[0]);
const fromAdmin = (data: Record<string, unknown>) =>
  act(() => {
    const ev = new Event('message') as Event & { origin: string; source: unknown; data: unknown };
    Object.assign(ev, {
      origin: ADMIN,
      source: parent,
      data: { protocol: BUILDER_PROTOCOL, ...data },
    });
    window.dispatchEvent(ev);
  });
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });

describe('cycleIndex', () => {
  it('wraps both ways and starts at the ends when nothing is focused', () => {
    expect(cycleIndex(3, -1, false)).toBe(0);
    expect(cycleIndex(3, -1, true)).toBe(2);
    expect(cycleIndex(3, 2, false)).toBe(0);
    expect(cycleIndex(3, 0, true)).toBe(2);
    expect(cycleIndex(3, 1, false)).toBe(2);
    expect(cycleIndex(0, -1, false)).toBe(-1);
  });
});

describe('canvas keyboard path', () => {
  it('Tab cycles text, then image, then toolbar targets of the selected block, and wraps', () => {
    const d = doc();
    const heroId = page(d);
    mount(d);
    fromAdmin({ type: 'select', sectionId: heroId, blockId: 'slide-1' });
    const order: string[] = [];
    for (let i = 0; i < 12; i++) {
      key('Tab');
      const a = document.activeElement as HTMLElement;
      order.push(
        a.id ||
          a.getAttribute('data-builder-change-image') ||
          a.getAttribute('data-builder-toolbar') ||
          '?'
      );
    }
    expect(order[0]).toBe('t1');
    expect(order[1]).toBe('image');
    expect(order.slice(2, 4).every(x => x !== '?')).toBe(true);
    // it came back around to the first target: the cycle is closed, focus never leaves the canvas
    expect(order.slice(1).includes('t1')).toBe(true);
    // Shift+Tab goes the other way
    key('Tab', { shiftKey: true });
    const back = document.activeElement as HTMLElement;
    expect(back).not.toBe(document.body);
  });

  it('Tab does nothing special when nothing is selected', () => {
    const d = doc();
    page(d);
    mount(d);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Esc asks the admin to take focus back to the tree', () => {
    const d = doc();
    const heroId = page(d);
    mount(d);
    fromAdmin({ type: 'select', sectionId: heroId });
    key('Tab');
    key('Escape');
    expect(posted()).toContainEqual({ protocol: BUILDER_PROTOCOL, type: 'focus-tree' });
  });

  it('a page form field and IME composition keep their native Tab / Esc (nothing is intercepted)', () => {
    const d = doc();
    const heroId = page(d);
    document.body.insertAdjacentHTML('beforeend', '<input id="news" />');
    mount(d);
    fromAdmin({ type: 'select', sectionId: heroId });
    (document.getElementById('news') as HTMLInputElement).focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
    (document.getElementById('news') as HTMLInputElement).blur();
    (document.body as HTMLElement).focus();
    const composing = new KeyboardEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(posted()).not.toContainEqual({ protocol: BUILDER_PROTOCOL, type: 'focus-tree' });
  });

  it('Esc while editing only cancels the edit', () => {
    const d = doc();
    const heroId = page(d);
    mount(d);
    fromAdmin({ type: 'select', sectionId: heroId, blockId: 'slide-1' });
    key('Tab');
    key('Enter'); // edits t1
    expect(document.getElementById('t1')!.getAttribute('contenteditable')).toBeTruthy();
    key('Escape');
    expect(document.getElementById('t1')!.hasAttribute('contenteditable')).toBe(false);
    expect(posted().some(m => m.type === 'focus-tree')).toBe(false);
  });

  it('Alt+ArrowDown asks to move the selected section down; a disabled direction asks nothing', () => {
    const d = doc();
    const heroId = page(d);
    mount(d);
    fromAdmin({ type: 'select', sectionId: heroId });
    key('Tab');
    key('ArrowDown', { altKey: true });
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'section-op',
      sectionId: heroId,
      op: 'moveDown',
    });
    parent.postMessage.mockClear();
    key('ArrowUp', { altKey: true }); // hero is first: moveUp is disabled
    expect(posted().some(m => m.type === 'section-op')).toBe(false);
  });

  it('a parent focus message selects the target and lands focus on its first text', () => {
    const d = doc();
    const heroId = page(d);
    mount(d);
    fromAdmin({ type: 'focus', sectionId: heroId, blockId: 'slide-2' });
    expect(document.activeElement?.id).toBe('t2');
    expect(document.querySelector('[data-builder-outline="selected"]')).toBeTruthy();
  });

  it('toolbar glyphs show their label from md (768px) up, and stay glyph-only below', () => {
    const d = doc();
    const heroId = page(d);
    mount(d);
    fromAdmin({ type: 'select', sectionId: heroId });
    const btn = () => document.querySelector('[data-builder-toolbar="duplicate"]')!;
    expect(btn().textContent).toBe('Duplicate');
    cleanup();
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    page(d);
    mount(d);
    fromAdmin({ type: 'select', sectionId: heroId });
    expect(btn().textContent).toBe('');
    expect(btn().getAttribute('aria-label')).toBe('Duplicate');
  });

  it('Arabic labels are Arabic', () => {
    const d = doc();
    const heroId = page(d);
    mount(d, 'ar');
    fromAdmin({ type: 'select', sectionId: heroId });
    expect(document.querySelector('[data-builder-toolbar="duplicate"]')!.textContent).toBe('تكرار');
  });
});
