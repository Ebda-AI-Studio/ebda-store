// @vitest-environment jsdom
/**
 * The home hero's one cycling phone (MKT-1): first frame static, cycles at most every 4s,
 * pauses on hover and focus, has a visible pause control, never cycles under reduced motion.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { HeroPhone } from '../../apps/marketing/src/components/HeroPhone';
import { COPY } from '../../apps/marketing/src/lib/content';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frag = (id: string) =>
  readFileSync(path.resolve(__dirname, '../../apps/marketing/public/looks', `${id}.html`), 'utf8');
const copy = COPY.ar;
const templates = copy.looks.templates;

function mount() {
  return render(
    <HeroPhone copy={copy.hero.phone} templates={templates} initialHtml={frag('qamar')} />
  );
}
const name = (c: HTMLElement) => c.querySelector('.hero-phone-name b')!.textContent;
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
let fetchMock: ReturnType<typeof vi.fn>;

function media(reduced: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduced && q.includes('reduce'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    text: async () => frag(String(url).replace('/looks/', '')),
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HeroPhone', () => {
  it('starts on the first template, fetches the others after load, then cycles every 4s', async () => {
    media(false);
    const { container } = mount();
    expect(name(container)).toBe(templates[0].name);
    expect(container.querySelector('#hp-qamar-a')).not.toBeNull();
    expect(container.querySelector('#ph-qamar-a')).toBeNull();
    await tick(2600); // idle prefetch of the 4 other fragments
    expect(fetchMock.mock.calls.map(c => c[0]).sort()).toEqual(
      templates
        .slice(1)
        .map(t => `/looks/${t.id}`)
        .sort()
    );
    await tick(3000); // < 4s since mount-timer start: still the first
    await tick(1500);
    expect(name(container)).toBe(templates[1].name);
    await tick(4000);
    expect(name(container)).toBe(templates[2].name);
    // the dot for the current template is marked
    const dots = [...container.querySelectorAll('.hero-phone-dot')];
    expect(dots).toHaveLength(5);
    expect(dots.map(d => d.getAttribute('aria-current'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  it('pauses on hover and resumes on leave', async () => {
    media(false);
    const { container } = mount();
    await tick(2600);
    const phone = container.querySelector('.look-phone')!;
    fireEvent.mouseEnter(phone);
    await tick(12000);
    expect(name(container)).toBe(templates[0].name);
    fireEvent.mouseLeave(phone);
    await tick(4100);
    expect(name(container)).toBe(templates[1].name);
  });

  it('pauses while focus is inside the group', async () => {
    media(false);
    const { container } = mount();
    await tick(2600);
    const dot = container.querySelector('.hero-phone-dot') as HTMLElement;
    act(() => dot.focus());
    await tick(12000);
    expect(name(container)).toBe(templates[0].name);
    act(() => dot.blur());
    await tick(4100);
    expect(name(container)).toBe(templates[1].name);
  });

  it('has a visible pause control that stops and restarts the cycle', async () => {
    media(false);
    const { container } = mount();
    await tick(2600);
    const btn = container.querySelector('.hero-phone-pause') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe(copy.hero.phone.pause);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-label')).toBe(copy.hero.phone.play);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    await tick(12000);
    expect(name(container)).toBe(templates[0].name);
    fireEvent.click(btn);
    await tick(4100);
    expect(name(container)).toBe(templates[1].name);
  });

  it('a dot jumps to that template once its fragment has loaded', async () => {
    media(false);
    const { container } = mount();
    await tick(2600);
    fireEvent.click(container.querySelectorAll('.hero-phone-dot')[4]);
    expect(name(container)).toBe(templates[4].name);
  });

  it('never cycles, fetches nothing and shows no pause button under reduced motion', async () => {
    media(true);
    const { container } = mount();
    await tick(20000);
    expect(name(container)).toBe(templates[0].name);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('.hero-phone-pause')).toBeNull();
  });

  it('keeps the phone decorative: inert, hidden from assistive tech, one labelled group', () => {
    media(false);
    const { container } = mount();
    const screen = container.querySelector('.look-screen')!;
    expect(screen.getAttribute('aria-hidden')).toBe('true');
    expect(screen.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[role="group"]')!.getAttribute('aria-label')).toBe(
      copy.hero.phone.label
    );
  });
});
