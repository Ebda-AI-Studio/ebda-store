// @vitest-environment jsdom
/**
 * Task 13: the canvas coalesces `render` posts to one per animation frame, latest document wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { BUILDER_PROTOCOL, layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { Canvas } from './Canvas';

const ORIGIN = 'https://shop.test';
let frames: Array<() => void> = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const runFrame = () => {
  const cbs = frames;
  frames = [];
  act(() => cbs.forEach(cb => cb()));
};

function mount() {
  const base = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
  const props = {
    storefrontUrl: ORIGIN,
    token: 't',
    viewport: 'mobile' as const,
    selectedId: null,
    reloadKey: 1,
    onMessage: () => {},
  };
  const r = render(<Canvas {...props} doc={base} />);
  const win = (r.container.querySelector('iframe') as HTMLIFrameElement).contentWindow!;
  const spy = vi.spyOn(win, 'postMessage');
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: ORIGIN,
        source: win,
        data: { protocol: BUILDER_PROTOCOL, type: 'ready' },
      })
    );
  });
  const renders = () => spy.mock.calls.filter(c => (c[0] as { type: string }).type === 'render');
  const edit = (i: number, heading: string) => {
    const d = structuredClone(base);
    d.sections[i].settings = { ...d.sections[i].settings, heading };
    r.rerender(<Canvas {...props} doc={d} />);
    return d;
  };
  return { renders, edit, spy };
}

describe('Canvas render coalescing', () => {
  it('ten edits in one frame post ONE render, with the last document', () => {
    const { renders, edit } = mount();
    runFrame(); // the ready-time render
    const before = renders().length;
    let last;
    for (let i = 0; i < 10; i++) last = edit(1, `h${i}`);
    expect(renders().length).toBe(before); // nothing posted before the frame
    runFrame();
    expect(renders().length).toBe(before + 1);
    expect((renders().at(-1)![0] as { definition: unknown }).definition).toEqual(last);
  });

  it('a later frame posts again', () => {
    const { renders, edit } = mount();
    runFrame();
    const before = renders().length;
    edit(1, 'a');
    runFrame();
    edit(1, 'b');
    runFrame();
    expect(renders().length).toBe(before + 2);
  });
});
