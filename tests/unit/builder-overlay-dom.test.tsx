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
      'modern'
    )
  );

function page(d: PageDefinition) {
  const hero = d.sections.find(n => n.type === 'hero')!;
  document.body.innerHTML = `
    <div data-zone="header"><nav id="nav">menu</nav></div>
    <main>
      <div data-builder-id="${hero.id}" style="display:contents">
        <section id="hero"><div id="s1" data-builder-block="slide-1"><h1 id="t1">A</h1></div>
        <div id="s2" data-builder-block="slide-2"><h1 id="t2">B</h1></div></section>
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
});
