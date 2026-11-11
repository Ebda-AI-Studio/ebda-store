import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// S5-20 and S5-24: a merchant sees plain words first. No bare "Draco/KTX2" slash jargon, and the conflict button says what it does.
const load = (l: string) =>
  readFileSync(join(__dirname, `../../apps/admin/src/i18n/messages/${l}.json`), 'utf8');

describe('admin copy clarity', () => {
  for (const l of ['en', 'ar']) {
    const src = load(l);
    it(`${l}: 3D format hint has no bare Draco/KTX2 jargon`, () => {
      expect(src).not.toMatch(/Draco\/KTX2/);
    });
  }
  it('the editor conflict button says it discards my changes', () => {
    expect(load('en')).not.toMatch(/"takeTheirs": "Load their version"/);
    expect(load('ar')).not.toMatch(/"takeTheirs": "حمّل نسختهم"/);
    expect(load('en')).toMatch(/"takeTheirs": "Discard my changes/);
  });
});
