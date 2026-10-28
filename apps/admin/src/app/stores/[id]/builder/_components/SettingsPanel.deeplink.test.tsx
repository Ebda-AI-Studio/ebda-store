// @vitest-environment jsdom
/**
 * Task 11: a deep link to a Design-mode field opens the panel in Design mode with that field
 * present and marked, and a link to a field the section does not have changes nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({ data: { typography: { zones: {} } } })),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));

import { SettingsPanel } from './SettingsPanel';

const doc = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const hero = doc.sections.find(n => n.type === 'hero')!;

function panel(focusField?: string) {
  render(
    <SettingsPanel
      storeId="s1"
      doc={doc}
      selection={{ sectionId: hero.id }}
      viewport="desktop"
      theme={undefined}
      template="qamar"
      errors={[]}
      dispatch={vi.fn()}
      focusField={focusField}
    />
  );
}
afterEach(cleanup);

describe('SettingsPanel deep link', () => {
  it('opens Design mode for a design field (by schema id and by registry id)', () => {
    panel('typography');
    expect(screen.getByRole('tab', { name: 'design' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-field-id="typography"]')).not.toBeNull();
    cleanup();
    panel('builder.dividers');
    expect(screen.getByRole('tab', { name: 'design' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-setting-id="builder.dividers"]')).not.toBeNull();
  });

  it('stays on Content with no link, and for a field the section does not have', () => {
    panel();
    expect(screen.getByRole('tab', { name: 'content' }).getAttribute('aria-selected')).toBe('true');
    cleanup();
    panel('no-such-field');
    expect(screen.getByRole('tab', { name: 'content' }).getAttribute('aria-selected')).toBe('true');
  });
});
