import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_GROUPS } from '../../../../lib/settings-groups';

const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
const ar = JSON.parse(
  readFileSync(join(__dirname, '../../../../i18n/fragments/t3.ar.json'), 'utf8')
);
const base = JSON.parse(readFileSync(join(__dirname, '../../../../i18n/messages/ar.json'), 'utf8'));

describe('settings hub groups (UX:SH-1, N-3)', () => {
  it('has the five groups, developers collapsed', () => {
    expect(SETTINGS_GROUPS.map(g => g.key)).toEqual([
      'store',
      'sales',
      'visibility',
      'team',
      'developers',
    ]);
    expect(SETTINGS_GROUPS.filter(g => g.collapsed).map(g => g.key)).toEqual(['developers']);
  });

  it('every grouped item has a card on the hub page and a title in the messages', () => {
    for (const item of SETTINGS_GROUPS.flatMap(g => g.items)) {
      expect(page, item.card).toContain(`key: '${item.card}'`);
      const t = ar.settings?.cards?.[item.card] ?? base.settings.cards[item.card];
      expect(t?.title, item.card).toBeTruthy();
      expect(t?.description, item.card).toBeTruthy();
    }
  });

  it('no card sits in two groups', () => {
    const all = SETTINGS_GROUPS.flatMap(g => g.items.map(i => i.card));
    expect(new Set(all).size).toBe(all.length);
  });

  it('the hub header has no "back to store" button (rule 3)', () => {
    expect(page).not.toContain('page.backToStore');
  });

  it('group headings exist', () => {
    for (const g of SETTINGS_GROUPS) expect(ar.settings.groups[g.key], g.key).toBeTruthy();
  });
});
