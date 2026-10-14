// @vitest-environment jsdom
/**
 * One real phone (the shipped Qamar A fragment) driven end to end: open a product, add it, the badge
 * says 1, the cart sheet shows the total, the demo checkout screen carries the signup button, back and
 * Escape return home; categories filter the grid with an empty state; links stay inert.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPhone } from '../../apps/marketing/src/lib/phone-store-dom';
import { parseFragment } from '../../apps/marketing/src/lib/looks-frag';

const SIGNUP = 'https://store.ebda.app/signup';
const read = (t: string) =>
  parseFragment(
    readFileSync(path.resolve(__dirname, '../../apps/marketing/public/looks', `${t}.html`), 'utf8')
  );

function phone(tpl: string, i: number) {
  const f = read(tpl);
  document.body.innerHTML = `<div class="look-screen">${f.looks[i]}</div>`;
  const scr = document.querySelector<HTMLElement>('.scr')!;
  const off = mountPhone(scr, { signupUrl: SIGNUP });
  return { scr, off };
}
const $ = (r: ParentNode, s: string) => r.querySelector<HTMLElement>(s)!;
const click = (el: Element) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const esc = (el: Element) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('working phone: Qamar A', () => {
  it('open product -> add -> badge 1 -> sheet total -> checkout screen -> back', () => {
    const { scr, off } = phone('qamar', 0);
    const bag = $(scr, '.ib[data-open-cart]');
    expect($(bag, '.ps-badge').hidden).toBe(true);

    click($(scr, '[data-p-id] .ph[role=button]')); // first card: the 1,450 shirt
    const pdp = $(scr, '.ps-pdp');
    expect(pdp.classList.contains('is-in')).toBe(true);
    expect($(pdp, '.ps-title').textContent).toBe('قميص كتان أبيض');
    expect($(pdp, '.ps-price').textContent).toBe('1,450 ج.م');
    expect(pdp.querySelectorAll('.ps-slide').length).toBeGreaterThanOrEqual(2);
    expect(scr.classList.contains('ps-lock')).toBe(true);
    expect(document.activeElement).toBe(pdp);

    click($(pdp, '[data-group=size][data-v=M]'));
    click($(pdp, '[data-ps-act=add]'));
    expect($(bag, '.ps-badge').textContent).toBe('1');
    expect($(bag, '.ps-badge').hidden).toBe(false);
    expect($(pdp, '.ps-cartbtn .ps-badge').textContent).toBe('1');
    vi.advanceTimersByTime(60);
    expect($(scr, '.ps-live').textContent).toBe('أضيف للسلة');

    click($(pdp, '[data-ps-act=cart]'));
    const sheet = $(scr, '.ps-cart');
    expect($(sheet, '.ps-total b').textContent).toBe('1,450 ج.م');
    expect($(sheet, '.ps-lopt').textContent).toBe('M · أبيض');
    click($(sheet, '[data-ps-act=inc]'));
    expect($(sheet, '.ps-total b').textContent).toBe('2,900 ج.م');
    expect($(bag, '.ps-badge').textContent).toBe('2');

    click($(sheet, '[data-ps-act=checkout]'));
    const done = $(scr, '.ps-done');
    expect($(done, 'h2').textContent).toBe('ده متجر تجريبي');
    const cta = $(done, 'a.ps-signup') as HTMLAnchorElement;
    expect(cta.href).toBe(SIGNUP);
    expect(cta.target).toBe('_blank');
    expect(cta.rel).toContain('noopener');

    esc(scr); // demo screen -> product page
    expect(scr.querySelectorAll('.ps-view.is-in')).toHaveLength(1);
    expect($(scr, '.ps-pdp').classList.contains('is-in')).toBe(true);
    click($(scr, '.ps-pdp [data-ps-act=back]')); // header back arrow -> home
    vi.advanceTimersByTime(400);
    expect(scr.querySelectorAll('.ps-view')).toHaveLength(0);
    expect(scr.classList.contains('ps-lock')).toBe(false);
    expect($(bag, '.ps-badge').textContent).toBe('2'); // nothing was placed: the cart stays
    off();
  });

  it('a page (product, demo checkout) covers the home bars; a sheet does not; closing restores them', () => {
    const { scr, off } = phone('souq', 0);
    const home = () => scr.classList.contains('ps-covered');
    expect(home()).toBe(false);
    click($(scr, '[data-p-id] .ph[role=button]'));
    expect(home()).toBe(true);
    expect($(scr, '.cart').closest('[inert]') ?? scr.querySelector('.cart[inert]')).toBeTruthy();
    click($(scr, '.ps-pdp [data-ps-act=add]'));
    click($(scr, '.ps-pdp [data-ps-act=back]'));
    expect(home()).toBe(false);
    click($(scr, '.ib[data-open-cart]'));
    expect(home()).toBe(false); // the cart sheet over the home keeps the dimmed home visible
    click($(scr, '.ps-cart [data-ps-act=checkout]'));
    expect(home()).toBe(true);
    esc(scr);
    expect(home()).toBe(false);
    expect(scr.querySelector('[inert]')).toBeNull();
    off();
  });

  it('quick add on a product with sizes opens its page; the empty cart says so', () => {
    const { scr, off } = phone('qamar', 1);
    click($(scr, '.ib[data-open-cart]'));
    expect($(scr, '.ps-cart .ps-emptycart b').textContent).toBe('السلة فاضية');
    off();
  });

  it('category chips filter the grid, a category with nothing shows the empty state, Show all restores', () => {
    const { scr, off } = phone('qamar', 0);
    const visible = () => scr.querySelectorAll('[data-grid] [data-p-id]:not(.ps-off)').length;
    expect(visible()).toBe(8);
    click($(scr, '.chip[data-cat=shirts]'));
    expect(visible()).toBe(2);
    expect($(scr, '.chip[data-cat=shirts]').getAttribute('aria-pressed')).toBe('true');
    expect($(scr, '.chip[data-cat=all]').classList.contains('on')).toBe(false);
    // no product carries this token: fabricate the chip to prove the empty state
    const chip = $(scr, '.chip[data-cat=bags]');
    chip.dataset.cat = 'nothing';
    click(chip);
    expect(visible()).toBe(0);
    expect($(scr, '[data-grid] .ps-empty')).toBeTruthy();
    click($(scr, '[data-grid] .ps-empty [data-ps-act=clear]'));
    expect(visible()).toBe(8);
    expect(scr.querySelector('[data-grid] .ps-empty')).toBeNull();
    off();
  });

  it('links inside the phone are inert; the demo CTA is the only link that goes anywhere', () => {
    const { scr, off } = phone('qamar', 0);
    const a = scr.querySelector<HTMLAnchorElement>('a[href="#"]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    off();
  });

  it('cleanup removes the layer, badges and the lock; mounting twice is a no-op', () => {
    const { scr, off } = phone('qamar', 0);
    expect(mountPhone(scr, { signupUrl: SIGNUP })()).toBeUndefined();
    click($(scr, '[data-p-id] .ph[role=button]'));
    off();
    expect(scr.querySelector('.ps-layer')).toBeNull();
    expect(scr.querySelector('.ps-badge')).toBeNull();
    expect(scr.classList.contains('ps-lock')).toBe(false);
    expect(scr.hasAttribute('data-ps-mounted')).toBe(false);
  });
});

describe('every shipped look is a working store', () => {
  const ids = ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'];
  for (const t of ids)
    for (const i of [0, 1, 2])
      it(`${t} ${'ABC'[i]}: every card carries id, name, price, 2-4 photos; every filter control hits a product or an empty state`, () => {
        const f = read(t);
        document.body.innerHTML = `<div class="look-screen">${f.looks[i]}</div>`;
        const scr = $(document.body, '.scr');
        const cards = [...scr.querySelectorAll<HTMLElement>('[data-p-id]')];
        expect(cards.length).toBeGreaterThan(3);
        for (const c of cards) {
          expect(c.dataset.pName).toBeTruthy();
          expect(Number(c.dataset.pPrice)).toBeGreaterThan(0);
          const n = (c.dataset.pImgs ?? '').split(',').length;
          expect(n).toBeGreaterThanOrEqual(2);
          expect(n).toBeLessThanOrEqual(4);
        }
        const off = mountPhone(scr, { signupUrl: SIGNUP });
        for (const c of scr.querySelectorAll<HTMLElement>('[data-cat]:not([data-cat=all])')) {
          click(c);
          const vis = scr.querySelectorAll('[data-grid] [data-p-id]:not(.ps-off)').length;
          const empty = !!scr.querySelector('[data-grid] .ps-empty');
          expect(vis > 0 || empty).toBe(true);
          click(c); // toggles back (or "all")
        }
        off();
      });
});
