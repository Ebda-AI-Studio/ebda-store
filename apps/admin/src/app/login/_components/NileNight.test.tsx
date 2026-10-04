// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NileNight } from './NileNight';

const ctx = new Proxy(
  {
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : vi.fn()), set: () => true }
);

function setup(reduce: boolean) {
  const raf = vi.fn(() => 7);
  const caf = vi.fn();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce') }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  return { raf, caf };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NileNight', () => {
  it('is aria-hidden', () => {
    setup(false);
    const { container } = render(<NileNight />);
    expect(container.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reduced motion renders one static frame and never schedules a frame', () => {
    const { raf } = setup(true);
    render(<NileNight />);
    expect(raf).not.toHaveBeenCalled();
  });

  it('animates by default and unmount cancels the pending frame', () => {
    const { raf, caf } = setup(false);
    const { unmount } = render(<NileNight />);
    expect(raf).toHaveBeenCalledTimes(1);
    unmount();
    expect(caf).toHaveBeenCalledWith(7);
  });
});
