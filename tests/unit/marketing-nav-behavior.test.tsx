// @vitest-environment jsdom
/**
 * NavBehavior (apps/marketing): Esc closes the open menu and returns focus to its trigger, a pointer or focus outside
 * closes it, opening one menu closes the other, a plain link click closes it (a modified click does not), and the
 * trigger carries aria-expanded in step with the open state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NavBehavior } from '../../apps/marketing/src/components/NavBehavior';

afterEach(cleanup);

function setup() {
  const r = render(
    <header className="site-header">
      <details id="a">
        <summary>A</summary>
        <a href="#x">link</a>
      </details>
      <details id="b">
        <summary>B</summary>
        <a href="#y">link</a>
      </details>
      <button id="out">outside</button>
      <NavBehavior />
    </header>
  );
  const q = (id: string) => r.container.querySelector<HTMLDetailsElement>(`#${id}`)!;
  const open = (d: HTMLDetailsElement) => {
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
  };
  return { r, a: q('a'), b: q('b'), open };
}

describe('NavBehavior', () => {
  it('sets aria-expanded on every trigger and keeps it in step', () => {
    const { a, open } = setup();
    const s = a.querySelector('summary')!;
    expect(s.getAttribute('aria-expanded')).toBe('false');
    open(a);
    expect(s.getAttribute('aria-expanded')).toBe('true');
  });
  it('Esc closes the open menu and returns focus to its trigger', () => {
    const { a, open } = setup();
    open(a);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(a.open).toBe(false);
    expect(document.activeElement).toBe(a.querySelector('summary'));
  });
  it('opening one menu closes the other', () => {
    const { a, b, open } = setup();
    open(a);
    open(b);
    expect(a.open).toBe(false);
    expect(b.open).toBe(true);
  });
  it('a pointer or focus outside closes it', () => {
    const { a, r, open } = setup();
    const out = r.container.querySelector<HTMLElement>('#out')!;
    open(a);
    fireEvent.pointerDown(out);
    expect(a.open).toBe(false);
    open(a);
    out.focus();
    expect(a.open).toBe(false);
  });
  it('a plain link click closes the menu; a ctrl-click does not', () => {
    const { a, open } = setup();
    const link = a.querySelector('a')!;
    open(a);
    fireEvent.click(link, { ctrlKey: true });
    expect(a.open).toBe(true);
    fireEvent.click(link);
    expect(a.open).toBe(false);
  });
});
