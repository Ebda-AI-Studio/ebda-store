// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { RowActions } from './RowActions';

afterEach(cleanup);

describe('RowActions menu layer', () => {
  it('renders the menu in a portal on <body>, outside any card stacking context', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden', transform: 'translateZ(0)' }}>
        <RowActions items={[{ label: 'Delete', destructive: true, onSelect: () => {} }]} />
      </div>
    );
    fireEvent.click(screen.getByRole('button'));
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('selects an item and closes', () => {
    const onSelect = vi.fn();
    render(<RowActions items={[{ label: 'Delete', onSelect }]} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitem'));
    expect(onSelect).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
