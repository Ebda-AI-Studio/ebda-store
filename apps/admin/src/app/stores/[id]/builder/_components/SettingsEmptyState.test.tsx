// @vitest-environment jsdom
/** F57: the empty inspector teaches: one sentence plus the common next steps, only the wired ones. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { SettingsEmptyState } from './SettingsEmptyState';
import { PageSettingsPanel } from './PageSettingsPanel';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

afterEach(cleanup);

describe('SettingsEmptyState', () => {
  it('says what to do and offers the three actions', () => {
    const run = { onAddSection: vi.fn(), onOpenTheme: vi.fn(), onOpenTemplates: vi.fn() };
    render(<SettingsEmptyState actions={run} />);
    expect(screen.getByText('emptyTitle')).toBeTruthy();
    for (const k of ['add', 'theme', 'template'])
      fireEvent.click(screen.getByTestId(`empty-action-${k}`));
    expect(run.onAddSection).toHaveBeenCalled();
    expect(run.onOpenTheme).toHaveBeenCalled();
    expect(run.onOpenTemplates).toHaveBeenCalled();
    expect(
      screen.getByTestId('settings-empty-state').querySelectorAll('svg').length
    ).toBeGreaterThanOrEqual(4);
  });
  it('offers only what is wired', () => {
    render(<SettingsEmptyState actions={{ onAddSection: vi.fn() }} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it('shows at the top of the page settings when nothing is selected', () => {
    render(
      <PageSettingsPanel
        storeId="s1"
        pageKey="home"
        doc={layoutToDefinition(resolveLayoutSettings({}, 'qamar'))}
        theme={undefined}
        dispatch={() => {}}
        emptyActions={{ onAddSection: vi.fn() }}
      />
    );
    const panel = screen.getByTestId('page-settings-panel');
    expect(panel.querySelector('[data-testid="settings-empty-state"]')).toBeTruthy();
  });
});
