import { describe, it, expect, vi } from 'vitest';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));

import {
  EMPTY_PERSONALISATION,
  personalisationForm,
  personalisationPayload,
} from './PersonalisationCard';

describe('personalisationPayload (the page sends this on PUT)', () => {
  it('off with nothing typed clears the column', () => {
    expect(personalisationPayload(EMPTY_PERSONALISATION)).toEqual({ value: null });
  });

  it('on needs a label in either language', () => {
    expect(personalisationPayload({ ...EMPTY_PERSONALISATION, enabled: true })).toEqual({
      error: 'needLabel',
    });
    expect(
      personalisationPayload({
        ...EMPTY_PERSONALISATION,
        enabled: true,
        labelAr: ' الاسم للتطريز ',
        maxLength: '12',
        required: true,
      })
    ).toEqual({
      value: { enabled: true, label: '', labelAr: 'الاسم للتطريز', maxLength: 12, required: true },
    });
  });

  it('rejects a max length outside 1..200 or not whole', () => {
    for (const maxLength of ['0', '201', '2.5', 'abc']) {
      expect(
        personalisationPayload({
          ...EMPTY_PERSONALISATION,
          enabled: true,
          label: 'Name',
          maxLength,
        })
      ).toEqual({ error: 'invalidMax' });
    }
  });

  it('off never blocks the save on a bad max length (falls back to 20)', () => {
    expect(
      personalisationPayload({ ...EMPTY_PERSONALISATION, label: 'Name', maxLength: '0' })
    ).toEqual({
      value: { enabled: false, label: 'Name', labelAr: '', maxLength: 20, required: false },
    });
  });

  it('off with labels keeps them (enabled:false) for re-enabling', () => {
    expect(personalisationPayload({ ...EMPTY_PERSONALISATION, label: 'Name' })).toEqual({
      value: { enabled: false, label: 'Name', labelAr: '', maxLength: 20, required: false },
    });
  });
});

describe('personalisationForm', () => {
  it('round-trips a stored config and defaults junk to the empty form', () => {
    const cfg = { enabled: true, label: 'Name', labelAr: 'الاسم', maxLength: 12, required: true };
    expect(personalisationPayload(personalisationForm(cfg))).toEqual({ value: cfg });
    expect(personalisationForm(null)).toEqual(EMPTY_PERSONALISATION);
    expect(personalisationForm('x')).toEqual(EMPTY_PERSONALISATION);
  });
});
