// @vitest-environment jsdom
/** QA-86: the row menu must not live inside a clipping card (DataTable's overflow-x-auto). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
import { RowActions } from './RowActions';

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
