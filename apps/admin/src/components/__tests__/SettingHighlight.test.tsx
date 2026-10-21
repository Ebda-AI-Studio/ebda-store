// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

let query = '';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(query),
  usePathname: () => '/stores/s1/delivery',
}));

import { SettingHighlight } from '../SettingHighlight';
import { isKnownSettingId } from '../../lib/settings-search';

beforeEach(() => {
  document.body.innerHTML = `<h3 data-setting-id="delivery.off-days">x</h3><p data-setting-id="not.registered">y</p>`;
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});
afterEach(cleanup);

describe('?setting= is untrusted input (Task review M3)', () => {
  it('a registered id is highlighted', () => {
    query = 'setting=delivery.off-days';
    render(<SettingHighlight />);
    expect(
      document
        .querySelector('[data-setting-id="delivery.off-days"]')!
        .classList.contains('setting-highlight')
    ).toBe(true);
  });

  it('an id the registry does not know does nothing, even when an element carries it', () => {
    query = 'setting=not.registered';
    render(<SettingHighlight />);
    expect(document.querySelector('.setting-highlight')).toBeNull();
    expect(isKnownSettingId('not.registered')).toBe(false);
  });

  it('a crafted value (newline, quote, bracket, selector) is ignored without throwing', () => {
    for (const bad of ['a\nb', 'x"],[href', ']', '*', '']) {
      query = `setting=${encodeURIComponent(bad)}`;
      expect(() => render(<SettingHighlight />)).not.toThrow();
      cleanup();
    }
    expect(document.querySelector('.setting-highlight')).toBeNull();
  });
});
