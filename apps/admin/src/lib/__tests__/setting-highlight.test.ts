// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIGHLIGHT_CLASS,
  HIGHLIGHT_MS,
  LOCATE_TIMEOUT_MS,
  findSettingElement,
  locateAndHighlight,
} from '../setting-highlight';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('admin search deep link: locate + highlight the control', () => {
  it('rings the control, scrolls it to the centre, focuses it and removes the ring after a while', () => {
    document.body.innerHTML = `<h3 data-setting-id="delivery.off-days">Days with no delivery</h3>`;
    const el = document.querySelector<HTMLElement>('[data-setting-id]')!;
    const found = vi.fn();
    locateAndHighlight('delivery.off-days', document, window, found);
    expect(found).toHaveBeenCalledWith(true);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(document.activeElement).toBe(el);
    vi.advanceTimersByTime(HIGHLIGHT_MS + 1);
    expect(el.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('opens a collapsed <details> around the control', () => {
    document.body.innerHTML = `<details><summary>Advanced</summary><label data-setting-id="seo.faqs">FAQ</label></details>`;
    locateAndHighlight('seo.faqs');
    expect(document.querySelector('details')!.open).toBe(true);
  });

  it('waits for a page that fetches its data first: the control appears later', () => {
    const found = vi.fn();
    locateAndHighlight('tax.enable', document, window, found);
    expect(found).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    document.body.innerHTML = `<h3 data-setting-id="tax.enable">Enable</h3>`;
    vi.advanceTimersByTime(300);
    expect(found).toHaveBeenCalledWith(true);
    expect(document.querySelector('[data-setting-id]')!.classList.contains(HIGHLIGHT_CLASS)).toBe(
      true
    );
  });

  it('gives up after the timeout (a feature the store lacks, a removed control) and reports not found', () => {
    const found = vi.fn();
    locateAndHighlight('nope.nope', document, window, found);
    vi.advanceTimersByTime(LOCATE_TIMEOUT_MS + 500);
    expect(found).toHaveBeenCalledWith(false);
    expect(found).toHaveBeenCalledTimes(1);
  });

  it('reduced motion: scrolls without animation', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    document.body.innerHTML = `<p data-setting-id="a.b">x</p>`;
    locateAndHighlight('a.b');
    expect(document.querySelector('p')!.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'auto',
    });
  });

  it('the cleanup stops the polling and removes the ring (navigating away mid-search)', () => {
    const stop = locateAndHighlight('late.control');
    stop();
    document.body.innerHTML = `<p data-setting-id="late.control">x</p>`;
    vi.advanceTimersByTime(2000);
    expect(document.querySelector('p')!.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('an id with quotes cannot break out of the selector', () => {
    document.body.innerHTML = `<p data-setting-id="a">x</p>`;
    expect(() => findSettingElement(document, 'a"],[x')).not.toThrow();
    expect(findSettingElement(document, 'a"],[x')).toBeNull();
  });

  it('control characters, newlines and brackets in an id never throw and never match', () => {
    document.body.innerHTML = `<p data-setting-id="a">x</p>`;
    for (const bad of ['a\n', 'a\u0000', 'a]\\', '"', '\u2028', ']\n[data-setting-id']) {
      expect(() => findSettingElement(document, bad)).not.toThrow();
      expect(findSettingElement(document, bad)).toBeNull();
    }
  });
});

describe('visual editor field deep link (Task 11)', () => {
  it('finds a generated section field by data-field-id, and a hostile id matches nothing', () => {
    document.body.innerHTML = `<div data-field-id="typography"><p>x</p></div>`;
    expect(findSettingElement(document, 'typography')).toBe(document.querySelector('div'));
    expect(findSettingElement(document, 'no-such-field')).toBeNull();
    expect(findSettingElement(document, '"]<script>')).toBeNull();
  });
});
