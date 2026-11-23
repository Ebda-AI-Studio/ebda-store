// @vitest-environment jsdom
/** QA-86: the row menu must not live inside a clipping card (DataTable's overflow-x-auto). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
import { RowActions, placeRowMenu } from './RowActions';

afterEach(cleanup);

describe('RowActions portal', () => {
  it('renders the open menu on document.body with fixed positioning, outside the clipping card', () => {
    const { container } = render(
      <div data-testid="card" style={{ overflow: 'hidden' }}>
        <RowActions
          menuLabel="more"
          items={[{ label: 'edit' }, { label: 'delete', destructive: true }]}
        />
      </div>
    );
    fireEvent.click(screen.getByLabelText('more'));
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    expect(screen.getAllByRole('menuitem').map(e => e.textContent)).toEqual(['edit', 'delete']);
  });

  it('an item still fires and closes the menu', () => {
    const onSelect = vi.fn();
    render(
      <RowActions menuLabel="more" items={[{ label: 'delete', destructive: true, onSelect }]} />
    );
    fireEvent.click(screen.getByLabelText('more'));
    fireEvent.click(screen.getByRole('menuitem'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('placeRowMenu viewport containment', () => {
  const W = 192;
  const within = (p: { left: number }, vw: number) => {
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + W).toBeLessThanOrEqual(vw - 8);
  };
  // The reported bug: trigger near the LEFT edge of a 390px phone, LTR. Old code set right = vw - trigger.right,
  // which put a 192px menu at a negative left.
  it.each([320, 390, 430])('LTR trigger near the left edge stays on screen at %ipx', vw => {
    const p = placeRowMenu({
      trigger: { top: 300, bottom: 344, left: 100, right: 144 },
      menuWidth: W,
      menuHeight: 160,
      viewport: { width: vw, height: 800 },
      rtl: false,
    });
    within(p, vw);
  });
  it.each([320, 390, 430])('RTL trigger near the right edge stays on screen at %ipx', vw => {
    const p = placeRowMenu({
      trigger: { top: 300, bottom: 344, left: vw - 60, right: vw - 16 },
      menuWidth: W,
      menuHeight: 160,
      viewport: { width: vw, height: 800 },
      rtl: true,
    });
    within(p, vw);
  });
  it('respects safe-area insets and flips above near the bottom', () => {
    const p = placeRowMenu({
      trigger: { top: 700, bottom: 744, left: 0, right: 44 },
      menuWidth: W,
      menuHeight: 160,
      viewport: { width: 390, height: 780 },
      inset: { top: 47, right: 0, bottom: 34, left: 20 },
      rtl: false,
    });
    expect(p.left).toBe(28);
    expect(p.top + 160).toBeLessThanOrEqual(780 - 8 - 34);
    expect(p.top).toBeLessThan(700);
  });
  it('DOM: opened menu left edge is never negative with a trigger near x=0', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 300,
      bottom: 344,
      left: 100,
      right: 144,
      width: 44,
      height: 44,
      x: 100,
      y: 300,
    } as DOMRect);
    const off = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(W);
    render(<RowActions menuLabel="more" items={[{ label: 'a' }]} />);
    fireEvent.click(screen.getByLabelText('more'));
    const left = Number.parseFloat(screen.getByRole('menu').style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    spy.mockRestore();
    off.mockRestore();
  });
});
