// @vitest-environment jsdom
/**
 * Screen-reader names for the settings panel: every field of every section, in both modes, has an
 * accessible name that says WHICH field it is. Found on the real stack (VoiceOver pass 2026-10-23):
 * plain text fields, colour dropdowns and the category picker had no name at all, and a localized
 * field read as just "Arabic" / "English" with no field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('../../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({ data: { typography: { zones: {} }, categories: [] } })),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));

import { SettingsPanel } from './SettingsPanel';

afterEach(cleanup);

/** The name a browser computes for a form control, close enough for these controls. */
function nameOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by)
    return by
      .split(' ')
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  const labels = (el as HTMLInputElement).labels;
  return labels && labels.length ? (labels[0].textContent ?? '').trim() : '';
}

describe('SettingsPanel: every control is named', () => {
  for (const template of ['qamar', 'dahab'] as const) {
    const doc = layoutToDefinition(resolveLayoutSettings({}, template));
    const nodes = [...doc.sections, ...doc.sectionGroups.header, ...doc.sectionGroups.footer];
    it(`${template}: ${nodes.length} sections, content + design`, () => {
      const unnamed: string[] = [];
      for (const node of nodes) {
        for (const mode of ['content', 'design'] as const) {
          render(
            <SettingsPanel
              storeId="s1"
              doc={doc}
              selection={{ sectionId: node.id }}
              viewport="desktop"
              theme={undefined}
              errors={[]}
              dispatch={() => {}}
            />
          );
          fireEvent.click(screen.getByRole('tab', { name: mode }));
          for (const el of document.querySelectorAll('input, select, textarea')) {
            const type = (el as HTMLInputElement).type;
            if (type === 'hidden' || type === 'file') continue;
            if (!nameOf(el)) unnamed.push(`${node.type}/${mode}: ${el.outerHTML.slice(0, 90)}`);
          }
          cleanup();
        }
      }
      expect(unnamed).toEqual([]);
    });
  }

  it('a localized text field is named after the field AND its language', () => {
    const doc = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
    const names: string[] = [];
    for (const node of doc.sections) {
      render(
        <SettingsPanel
          storeId="s1"
          doc={doc}
          selection={{ sectionId: node.id }}
          viewport="desktop"
          theme={undefined}
          errors={[]}
          dispatch={() => {}}
        />
      );
      for (const el of document.querySelectorAll('input[data-testid^="field-"]')) {
        if (el.getAttribute('data-testid')!.endsWith('Ar')) names.push(nameOf(el));
      }
      cleanup();
    }
    expect(names.length).toBeGreaterThan(0);
    // "<field> - <language>", never the bare language tag
    for (const n of names) expect(n).toMatch(/ - /);
  });
});
