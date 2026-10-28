// @vitest-environment jsdom
/**
 * The REAL storefront overlay (`EditorOverlay`) in a DOM: what it posts to the
 * admin parent on click and hover, the name chip, and that it speaks only to
 * an allowed origin. The admin E2E uses a contract fake of the canvas, so this
 * is the test that drives the shipped overlay code.
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
      'qamar'
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

/** jsdom has no layout: every element reports a box so chips and outlines render. */
beforeEach(() => {
  parent.postMessage.mockReset();
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s };
  Element.prototype.getBoundingClientRect = () =>
    ({ top: 100, left: 20, width: 300, height: 80, right: 320, bottom: 180 }) as DOMRect;
});
afterEach(cleanup);

const mountOverlay = (d: PageDefinition, locale: 'en' | 'ar' = 'en') =>
  render(
    <EditorOverlay allowedOrigins={[ADMIN]} locale={locale} definition={d} onRender={() => {}} />
  );

const posted = () => parent.postMessage.mock.calls.map(c => c[0]);

describe('EditorOverlay (real)', () => {
  it('announces ready only to the allowed admin origin, never a wildcard', () => {
    const d = doc();
    page(d);
    mountOverlay(d);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { protocol: BUILDER_PROTOCOL, type: 'ready' },
      ADMIN
    );
    expect(parent.postMessage.mock.calls.every(c => c[1] !== '*')).toBe(true);
  });

  it('a click on slide 2 selects that block; a click in the header/footer selects the chrome', () => {
    const d = doc();
    const heroId = page(d);
    mountOverlay(d);
    fireEvent.click(document.getElementById('t2')!);
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'select',
      sectionId: heroId,
      blockId: 'slide-2',
    });
    const header = d.sectionGroups.header.find(n => n.type === 'header')!;
    const footer = d.sectionGroups.footer.find(n => n.type === 'footer')!;
    fireEvent.click(document.getElementById('nav')!);
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'select',
      sectionId: header.id,
    });
    fireEvent.click(document.getElementById('foot')!);
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'select',
      sectionId: footer.id,
    });
  });

  it('hover shows a name chip in the admin language and reports the block', () => {
    const d = doc();
    const heroId = page(d);
    const { container, rerender } = mountOverlay(d, 'en');
    fireEvent.mouseOver(document.getElementById('t2')!);
    expect(document.querySelector('[data-builder-chip="hover"]')?.textContent).toBe('Slide 2');
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'hover',
      sectionId: heroId,
      blockId: 'slide-2',
    });
    rerender(
      <EditorOverlay allowedOrigins={[ADMIN]} locale="ar" definition={d} onRender={() => {}} />
    );
    expect(document.querySelector('[data-builder-chip="hover"]')?.textContent).toBe('شريحة 2');
    expect(container).toBeTruthy();
  });

  it('the selected target keeps a solid outline with its chip; a parent select message updates it', () => {
    const d = doc();
    const heroId = page(d);
    mountOverlay(d);
    act(() => {
      const ev = new Event('message') as Event & { origin: string; source: unknown; data: unknown };
      Object.assign(ev, {
        origin: ADMIN,
        source: parent,
        data: { protocol: BUILDER_PROTOCOL, type: 'select', sectionId: heroId, blockId: 'slide-1' },
      });
      window.dispatchEvent(ev);
    });
    expect(document.querySelector('[data-builder-outline="selected"]')).toBeTruthy();
    expect(document.querySelector('[data-builder-chip="selected"]')?.textContent).toBe('Slide 1');
  });

  it('ignores a message from a foreign origin', () => {
    const d = doc();
    const heroId = page(d);
    mountOverlay(d);
    act(() => {
      const ev = new Event('message') as Event & { origin: string; source: unknown; data: unknown };
      Object.assign(ev, {
        origin: 'https://evil.test',
        source: parent,
        data: { protocol: BUILDER_PROTOCOL, type: 'select', sectionId: heroId },
      });
      window.dispatchEvent(ev);
    });
    expect(document.querySelector('[data-builder-outline="selected"]')).toBeNull();
  });

  it('the first click selects, the second click on its text edits in place, Enter sends patch-text', () => {
    const d = doc();
    const heroId = page(d);
    mountOverlay(d, 'en');
    const h = document.getElementById('t2')!;
    fireEvent.click(h);
    expect(h.hasAttribute('contenteditable')).toBe(false);
    expect(posted().some(m => m.type === 'patch-text')).toBe(false);

    fireEvent.click(h); // already selected: now it edits
    expect(h.getAttribute('contenteditable')).toBeTruthy();
    expect(h.getAttribute('dir')).toBe('ltr');
    h.textContent = ' Gift boxes ';
    fireEvent.keyDown(h, { key: 'Enter' });
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'patch-text',
      sectionId: heroId,
      blockId: 'slide-2',
      key: 'headline',
      value: 'Gift boxes',
    });
    expect(h.hasAttribute('contenteditable')).toBe(false);
  });

  it('editable text inside a button never runs the button: select, then edit, and the section handler stays silent', () => {
    // Jasmine's "add all to the cart" step button: its click handler used to run in the canvas
    // (cart add, then `disabled` blurred the inline editor the same instant, so the second tap
    // never visibly edited). The text of a control is a text target; the control stays inert.
    const d = doc();
    const heroId = page(d);
    document
      .getElementById('s2')!
      .insertAdjacentHTML(
        'beforeend',
        '<button id="cta" type="button" data-builder-setting="headline">Add all</button>'
      );
    const action = vi.fn();
    document.getElementById('cta')!.addEventListener('click', action); // a bubbling handler, like React's root
    mountOverlay(d, 'en');
    const cta = document.getElementById('cta')!;
    fireEvent.click(cta);
    expect(posted().some(m => m.type === 'select' && m.sectionId === heroId)).toBe(true);
    expect(action).not.toHaveBeenCalled(); // the select tap does not run the button either
    fireEvent.click(cta);
    expect(cta.getAttribute('contenteditable')).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
  });

  it('a click on text of ANOTHER target only selects it (no edit)', () => {
    const d = doc();
    page(d);
    mountOverlay(d, 'en');
    fireEvent.click(document.getElementById('t1')!);
    fireEvent.click(document.getElementById('t2')!);
    expect(document.getElementById('t2')!.hasAttribute('contenteditable')).toBe(false);
  });

  it('double-click edits even when nothing was selected, and Arabic fields edit RTL', () => {
    const d = doc();
    page(d);
    document.getElementById('t1')!.setAttribute('data-builder-setting', 'headlineAr');
    mountOverlay(d, 'ar');
    const h = document.getElementById('t1')!;
    fireEvent.dblClick(h);
    expect(h.getAttribute('dir')).toBe('rtl');
    expect(h.getAttribute('lang')).toBe('ar');
  });

  it('a selected slide shows a keyboard-reachable "change image" that asks the parent (target only, no url)', () => {
    const d = doc();
    const heroId = page(d);
    mountOverlay(d, 'ar');
    // nothing selected: no button
    expect(document.querySelector('[data-builder-change-image]')).toBeNull();
    fireEvent.click(document.getElementById('t1')!);
    const btn = document.querySelector<HTMLButtonElement>('[data-builder-change-image]')!;
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('تغيير الصورة');
    expect(btn.tabIndex).toBe(0);
    fireEvent.click(btn);
    const req = posted().find(m => m.type === 'request-media');
    expect(req).toEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'request-media',
      sectionId: heroId,
      blockId: 'slide-1',
      key: 'image',
    });
    expect(Object.keys(req).sort()).toEqual(['blockId', 'key', 'protocol', 'sectionId', 'type']);
  });

  it('only the images of the selected target get a button', () => {
    const d = doc();
    page(d);
    mountOverlay(d, 'en');
    fireEvent.click(document.getElementById('t2')!); // slide 2 has no image marker
    expect(document.querySelector('[data-builder-change-image]')).toBeNull();
  });
});

describe('EditorOverlay toolbar, drag and insert (real)', () => {
  /** Three template sections stacked at known boxes (jsdom has no layout). */
  function stack(d: PageDefinition) {
    const [a, b, c] = d.sections.slice(0, 3).map(n => n.id);
    document.body.innerHTML = [a, b, c]
      .map(
        id =>
          `<div data-builder-id="${id}" style="display:contents"><section id="sec-${id}">${id}</section></div>`
      )
      .join('');
    const tops: Record<string, [number, number]> = {
      [`sec-${a}`]: [0, 100],
      [`sec-${b}`]: [100, 150],
      [`sec-${c}`]: [250, 150],
    };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const [top, height] = tops[this.id] ?? [0, 0];
      return { top, left: 0, width: 1000, height, right: 1000, bottom: top + height } as DOMRect;
    };
    return { a, b, c };
  }
  const btn = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[data-builder-toolbar="${name}"]`)!;

  it('the toolbar appears on a selected section; each button posts one intent; ends are disabled', () => {
    const d = doc();
    const { a, b } = stack(d);
    mountOverlay(d, 'ar');
    expect(document.querySelector('[data-builder-toolbar-root]')).toBeNull();
    fireEvent.click(document.getElementById(`sec-${b}`)!);
    expect(document.querySelector('[data-builder-toolbar-root]')).toBeTruthy();
    // labelled for assistive tech, in Arabic
    expect(btn('moveUp').getAttribute('aria-label')).toBe('حرّك لفوق');
    expect(btn('remove').getAttribute('aria-label')).toBe('حذف');
    fireEvent.click(btn('moveUp'));
    fireEvent.click(btn('remove'));
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'section-op',
      sectionId: b,
      op: 'moveUp',
    });
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'section-op',
      sectionId: b,
      op: 'remove',
    });
    // first section: "up" is disabled
    fireEvent.click(document.getElementById(`sec-${a}`)!);
    expect(btn('moveUp').disabled).toBe(true);
  });

  it('dragging the handle shows a drop line and posts ONE move on drop; Escape cancels', () => {
    const d = doc();
    const { a, c } = stack(d);
    mountOverlay(d, 'en');
    fireEvent.click(document.getElementById(`sec-${c}`)!);
    fireEvent.pointerDown(btn('drag'), { button: 0, clientY: 300 });
    expect(document.querySelector('[data-builder-drag-ghost]')).toBeTruthy();
    fireEvent.pointerMove(window, { clientY: 8 }); // near the top edge: above A
    expect(document.querySelector('[data-builder-drop-line]')).toBeTruthy();
    fireEvent.pointerUp(window);
    const moves = posted().filter(m => m.type === 'move');
    expect(moves).toEqual([{ protocol: BUILDER_PROTOCOL, type: 'move', sectionId: c, toIndex: 0 }]);
    expect(document.querySelector('[data-builder-drag-ghost]')).toBeNull();

    // Escape: nothing is posted
    parent.postMessage.mockClear();
    fireEvent.click(document.getElementById(`sec-${a}`)!);
    fireEvent.pointerDown(btn('drag'), { button: 0, clientY: 50 });
    fireEvent.pointerMove(window, { clientY: 390 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window);
    expect(posted().some(m => m.type === 'move')).toBe(false);
  });

  it('a drop on the dragged section own place posts nothing', () => {
    const d = doc();
    const { b } = stack(d);
    mountOverlay(d, 'en');
    fireEvent.click(document.getElementById(`sec-${b}`)!);
    fireEvent.pointerDown(btn('drag'), { button: 0, clientY: 150 });
    fireEvent.pointerMove(window, { clientY: 160 });
    fireEvent.pointerUp(window);
    expect(posted().some(m => m.type === 'move')).toBe(false);
  });

  it('every gap has a keyboard-reachable "+" that asks the parent to insert at that index', () => {
    const d = doc();
    stack(d);
    mountOverlay(d, 'en');
    const plus = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-builder-insert] button')
    );
    // before the first, two between, after the last
    expect(plus).toHaveLength(4);
    expect(
      plus.every(p => p.tabIndex === 0 && p.getAttribute('aria-label') === 'Add section here')
    ).toBe(true);
    fireEvent.click(plus[1]);
    expect(posted()).toContainEqual({
      protocol: BUILDER_PROTOCOL,
      type: 'request-add',
      list: 'template',
      index: 1,
    });
  });

  it('only the "+" nearest the pointer is revealed', () => {
    const d = doc();
    stack(d);
    mountOverlay(d, 'en');
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      cb(0);
      return 0;
    });
    fireEvent.mouseMove(document.body, { clientY: 101 });
    const on = Array.from(document.querySelectorAll('[data-builder-insert]')).map(el =>
      el.getAttribute('data-on')
    );
    expect(on).toEqual(['false', 'true', 'false', 'false']);
    raf.mockRestore();
  });
});
