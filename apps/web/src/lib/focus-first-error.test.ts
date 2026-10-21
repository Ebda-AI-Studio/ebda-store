// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { focusFirstError } from './focus-first-error';

// R-13 (W3): checkout moves FOCUS to the first error (not just the scroll), and the scroll honours
// reduced motion.
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
const setMotion = (reduce: boolean) =>
  (window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce') })) as never);

describe('focusFirstError', () => {
  it('focuses the first field inside the first error and scrolls it to the centre', () => {
    setMotion(false);
    document.body.innerHTML = `<div data-error="false"><input id="a"></div><div data-error="true"><label>x</label><input id="b"></div><div data-error="true"><input id="c"></div>`;
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    expect(focusFirstError()).toBe(true);
    expect(document.activeElement?.id).toBe('b');
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });
  it('reduced motion: an instant scroll', () => {
    setMotion(true);
    document.body.innerHTML = `<div data-error="true"><select id="s"></select></div>`;
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    focusFirstError();
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    expect(document.activeElement?.id).toBe('s');
  });
  it('no error on the page: false, nothing moves', () => {
    expect(focusFirstError()).toBe(false);
  });
});
