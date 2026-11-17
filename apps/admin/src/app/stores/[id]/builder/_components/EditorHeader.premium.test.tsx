// @vitest-environment jsdom
/**
 * Editor premium header (findings 40-43, 45, 46): icon viewport segmented with width tooltip and a gold
 * underline, real undo/redo icons with platform-aware shortcut hints, an always-visible save pill, one
 * non-wrapping row split in start / centre / end, an overflow menu for the secondary action, a publish
 * popover, and a back arrow with the store name instead of the 15x28 logo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { EditorHeader } from './EditorHeader';

afterEach(cleanup);

type Props = React.ComponentProps<typeof EditorHeader>;
const base: Props = {
  storeId: 's1',
  storeName: 'Qamar',
  pageSwitcher: <span data-testid="ps" />,
  viewport: 'desktop' as const,
  onViewport: vi.fn(),
  canUndo: true,
  canRedo: true,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  saveState: 'saved' as const,
  publishing: false,
  unpublished: true,
  editCount: 3,
  onPublish: vi.fn(),
  showLook: true,
  lookOpen: false,
  onOpenLook: vi.fn(),
  drawer: null,
  onToggleDrawer: vi.fn(),
};
const mount = (over: Partial<Props> = {}) => render(<EditorHeader {...base} {...over} />);

describe('viewport switch (F40)', () => {
  it('is an icon radiogroup: svg icons, width in the name, aria-checked, gold underline on the active one', () => {
    mount({ viewport: 'tablet' });
    const group = screen.getByRole('radiogroup', { name: 'viewport.label' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    for (const r of radios) expect(r.querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('viewport-tablet').getAttribute('aria-label')).toMatch(/820px/);
    expect(screen.getByTestId('viewport-desktop').getAttribute('aria-label')).toMatch(/1280px/);
    expect(screen.getByTestId('viewport-tablet').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('viewport-tablet').className).toContain('border-primary');
    expect(screen.getByTestId('viewport-desktop').className).toContain('border-transparent');
    // the width also shows as a tooltip, not only in the name
    expect(
      within(screen.getByTestId('viewport-tablet').parentElement!).getByRole('tooltip').textContent
    ).toMatch(/820px/);
  });
  it('clicking a device reports it', () => {
    const onViewport = vi.fn();
    mount({ onViewport });
    fireEvent.click(screen.getByTestId('viewport-mobile'));
    expect(onViewport).toHaveBeenCalledWith('mobile');
  });
});

describe('undo / redo (F41)', () => {
  it('are svg icons, not glyph characters, with shortcut hints in the tooltip', () => {
    mount();
    const undo = screen.getByTestId('undo');
    const redo = screen.getByTestId('redo');
    expect(undo.querySelector('svg')).toBeTruthy();
    expect(redo.querySelector('svg')).toBeTruthy();
    expect(undo.textContent).not.toMatch(/[↶↷]/u);
    expect(within(undo.parentElement!).getByRole('tooltip').textContent).toMatch(/Ctrl\+Z|⌘Z/);
    expect(within(redo.parentElement!).getByRole('tooltip').textContent).toMatch(
      /Ctrl\+Shift\+Z|⇧⌘Z/
    );
    expect(undo.getAttribute('aria-keyshortcuts')).toMatch(/\+Z$/);
  });
  it('disabled when there is nothing to undo, and click runs the action', () => {
    const onUndo = vi.fn();
    mount({ canUndo: false, onUndo });
    expect((screen.getByTestId('undo') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount({ onUndo });
    fireEvent.click(screen.getByTestId('undo'));
    expect(onUndo).toHaveBeenCalled();
  });
});

describe('save pill (F42)', () => {
  it('is always rendered, a dot + short text, full text on hover, no fixed width', () => {
    mount({ saveState: 'dirty' });
    const pill = screen.getByTestId('save-status');
    expect(pill.getAttribute('data-state')).toBe('dirty');
    expect(pill.getAttribute('title')).toBe('status.dirty');
    expect(pill.querySelector('[data-dot]')).toBeTruthy();
    expect(pill.textContent).toContain('status.short.dirty');
    expect(pill.className).not.toMatch(/\bw-24\b/);
    expect(pill.className).not.toMatch(/\bhidden\b/);
    expect(pill.className).toContain('whitespace-nowrap');
  });
});

describe('grouping + overflow (F43)', () => {
  it('has start, centre and end groups, and never wraps', () => {
    mount();
    const header = screen.getByTestId('editor-header');
    expect(header.className).not.toContain('flex-wrap');
    expect(header.className).toContain('flex-nowrap');
    const groups = Array.from(header.querySelectorAll('[data-header-group]')).map(g =>
      g.getAttribute('data-header-group')
    );
    expect(groups).toEqual(['start', 'centre', 'end']);
    const start = header.querySelector('[data-header-group="start"]')!;
    expect(within(start as HTMLElement).getByTestId('ps')).toBeTruthy();
    expect(within(start as HTMLElement).getByTestId('back-link')).toBeTruthy();
    const end = header.querySelector('[data-header-group="end"]') as HTMLElement;
    expect(within(end).getByTestId('undo')).toBeTruthy();
    expect(within(end).getByTestId('save-status')).toBeTruthy();
    expect(within(end).getByTestId('publish-open')).toBeTruthy();
  });
  it('Change template is inline from 1180px and lives in the overflow menu below it', () => {
    const onOpenLook = vi.fn();
    mount({ onOpenLook });
    expect(screen.getByTestId('open-look-switch').className).toContain('min-[1180px]:inline-flex');
    const more = screen.getByTestId('header-overflow');
    expect(more.className).toContain('min-[1180px]:hidden');
    fireEvent.click(more);
    fireEvent.click(screen.getByTestId('overflow-look'));
    expect(onOpenLook).toHaveBeenCalled();
  });
});

describe('publish popover (F45)', () => {
  it('opens a summary with the edit count, and only Publish now publishes', () => {
    const onPublish = vi.fn();
    mount({ onPublish });
    expect(screen.queryByTestId('publish')).toBeNull();
    fireEvent.click(screen.getByTestId('publish-open'));
    expect(screen.getByTestId('publish-popover')).toBeTruthy();
    expect(screen.getByTestId('publish-count')).toBeTruthy();
    expect(onPublish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('publish'));
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('publish-popover')).toBeNull();
  });
  it('Escape closes it', () => {
    mount();
    fireEvent.click(screen.getByTestId('publish-open'));
    fireEvent.keyDown(screen.getByTestId('publish-popover'), { key: 'Escape' });
    expect(screen.queryByTestId('publish-popover')).toBeNull();
  });
  it('says everything is live when nothing is pending, and hides the count', () => {
    mount({ unpublished: false });
    fireEvent.click(screen.getByTestId('publish-open'));
    expect(screen.queryByTestId('publish-count')).toBeNull();
  });
});

describe('back link (F46)', () => {
  it('is a back arrow plus the store name, no 15x28 logo image', () => {
    mount();
    const link = screen.getByTestId('back-link');
    expect(link.getAttribute('href')).toBe('/stores/s1');
    expect(link.querySelector('svg')).toBeTruthy();
    expect(link.querySelector('img')).toBeNull();
    expect(link.textContent).toContain('Qamar');
    const src = readFileSync(
      'apps/admin/src/app/stores/[id]/builder/_components/BuilderEditor.tsx',
      'utf8'
    );
    expect(src).not.toContain('logo.svg');
  });
});
