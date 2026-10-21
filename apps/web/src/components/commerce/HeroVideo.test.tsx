// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { HeroVideo } from './HeroVideo';

const SRC = 'https://x.r2.dev/a.mp4';
const MOBILE = 'https://x.r2.dev/a-m.mp4';
const POSTER = 'https://x.r2.dev/a.webp';

function mockEnv(opts: { reduced?: boolean; mobile?: boolean; saveData?: boolean } = {}) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('prefers-reduced-motion') ? !!opts.reduced : !!opts.mobile,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'connection', {
    value: opts.saveData ? { saveData: true } : undefined,
    configurable: true,
  });
}

beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});
afterEach(cleanup);

describe('HeroVideo', () => {
  it('video falls back to poster under reduced motion', () => {
    mockEnv({ reduced: true });
    render(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('video falls back to poster on error, and the poster stays', () => {
    mockEnv();
    render(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    fireEvent.error(document.querySelector('video')!);
    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('respects Save-Data', () => {
    mockEnv({ saveData: true });
    render(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    expect(document.querySelector('video')).toBeNull();
  });

  it('plays muted, looping, inline, decorative, over the poster box', () => {
    mockEnv();
    render(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    const v = document.querySelector('video')!;
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.autoplay).toBe(true);
    expect(v.getAttribute('playsinline')).not.toBeNull();
    expect(v.getAttribute('preload')).toBe('metadata');
    expect(v.getAttribute('aria-hidden')).toBe('true');
    expect(v.className).toContain('absolute inset-0');
    expect(v.className).toContain('object-cover');
    expect(v.getAttribute('src')).toBe(SRC);
  });

  it('uses videoMobile on a mobile viewport, falling back to video', () => {
    mockEnv({ mobile: true });
    const { unmount } = render(<HeroVideo src={SRC} srcMobile={MOBILE} poster={POSTER} />);
    expect(document.querySelector('video')!.getAttribute('src')).toBe(MOBILE);
    unmount();
    render(<HeroVideo src={SRC} poster={POSTER} />);
    expect(document.querySelector('video')!.getAttribute('src')).toBe(SRC);
  });

  it('desktop viewport uses video even when videoMobile is set', () => {
    mockEnv({ mobile: false });
    render(<HeroVideo src={SRC} srcMobile={MOBILE} poster={POSTER} />);
    expect(document.querySelector('video')!.getAttribute('src')).toBe(SRC);
  });

  it('server HTML is the poster only: no video, even for a visitor who would get one', () => {
    mockEnv();
    const html = renderToString(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    expect(html).not.toContain('<video');
    expect(html).toContain(POSTER);
  });

  it('keeps passed children as the base layer and does not duplicate the poster on the video', () => {
    mockEnv();
    render(
      <HeroVideo src={SRC} poster={POSTER}>
        <img data-testid="base" src={POSTER} alt="Base" />
      </HeroVideo>
    );
    expect(screen.getByTestId('base')).toBeTruthy();
    expect(document.querySelector('video')!.hasAttribute('poster')).toBe(false);
  });

  it('removes the video when autoplay is refused', async () => {
    mockEnv();
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockRejectedValue(new DOMException('refused', 'NotAllowedError'));
    render(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    await vi.waitFor(() => expect(document.querySelector('video')).toBeNull());
  });

  it('pauses when inactive', () => {
    mockEnv();
    render(<HeroVideo src={SRC} poster={POSTER} active={false} />);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('framed hero: video is object-contain and never object-cover', () => {
    mockEnv();
    render(<HeroVideo src={SRC} poster={POSTER} fit="contain" />);
    const cls = document.querySelector('video')!.className;
    expect(cls).toContain('object-contain');
    expect(cls).not.toContain('object-cover');
  });

  it('an AbortError from play() (interrupted by pause) keeps the video mounted', async () => {
    mockEnv();
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockRejectedValue(new DOMException('interrupted', 'AbortError'));
    render(<HeroVideo src={SRC} poster={POSTER} />);
    await new Promise(r => setTimeout(r, 20));
    expect(document.querySelector('video')).not.toBeNull();
  });

  it('NotSupportedError removes the video', async () => {
    mockEnv();
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockRejectedValue(new DOMException('bad codec', 'NotSupportedError'));
    render(<HeroVideo src={SRC} poster={POSTER} />);
    await vi.waitFor(() => expect(document.querySelector('video')).toBeNull());
  });

  it('an inactive slide has no autoplay and preload=none, and starts when it becomes active', () => {
    mockEnv();
    const { rerender } = render(<HeroVideo src={SRC} poster={POSTER} active={false} />);
    const v = document.querySelector('video')!;
    expect(v.autoplay).toBe(false);
    expect(v.getAttribute('preload')).toBe('none');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    rerender(<HeroVideo src={SRC} poster={POSTER} active />);
    expect(document.querySelector('video')!.getAttribute('preload')).toBe('metadata');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});

// a11y P1-6 / rule (e) (W4): the looping hero video had no way to stop it (2.2.2).
describe('HeroVideo pause control', () => {
  it('a 44px pause button stops the video and turns into play', () => {
    mockEnv();
    render(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    const btn = document.querySelector('button[data-autoplay-toggle]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.className).toContain('h-11');
    fireEvent.click(btn);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
  it('no video (reduced motion): no button', () => {
    mockEnv({ reduced: true });
    render(<HeroVideo src={SRC} poster={POSTER} alt="Hero" />);
    expect(document.querySelector('button[data-autoplay-toggle]')).toBeNull();
  });
});
