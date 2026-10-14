import { describe, expect, it } from 'vitest';
import {
  activePersonalisation,
  cleanNote,
  stripNote,
  personalisationConfigSchema,
  personalisationLabel,
} from '@ebda/shared';

describe('personalisation', () => {
  it('cleans notes', () => {
    expect(cleanNote('  Sara ‮ ')).toBe('Sara');
    expect(cleanNote('a\u0000b')).toBe('ab');
    expect(cleanNote('⁦سارة⁩')).toBe('سارة');
    expect(cleanNote('a\u0085b\u009fc')).toBe('abc');
    expect(cleanNote('')).toBeNull();
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote(42)).toBeNull();
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote('x'.repeat(250))).toHaveLength(200);
  });

  it('strips LRM/RLM, ALM, zero-width chars, BOM and line separators', () => {
    expect(cleanNote('‎Sa‏ra؜')).toBe('Sara');
    expect(cleanNote('​O‌m‍a﻿r')).toBe('Omar');
    expect(cleanNote('Sa ra ')).toBe('Sara');
    expect(cleanNote('​‎﻿')).toBeNull();
    // Arabic letters and ordinary punctuation survive.
    expect(cleanNote('سارة & عمر')).toBe('سارة & عمر');
  });

  it('stripNote does not cap; cleanNote caps at 200', () => {
    expect(stripNote('x'.repeat(250))).toHaveLength(250);
    expect(cleanNote('x'.repeat(250))).toHaveLength(200);
  });

  it('validates config', () => {
    expect(
      personalisationConfigSchema.safeParse({
        enabled: true,
        label: '',
        labelAr: 'الاسم',
        maxLength: 20,
        required: true,
      }).success
    ).toBe(true);
    expect(
      personalisationConfigSchema.safeParse({
        enabled: true,
        label: '',
        labelAr: '',
        maxLength: 20,
        required: true,
      }).success
    ).toBe(false);
    expect(
      personalisationConfigSchema.safeParse({
        enabled: true,
        label: 'Name',
        labelAr: '',
        maxLength: 0,
        required: false,
      }).success
    ).toBe(false);
    expect(
      personalisationConfigSchema.safeParse({
        enabled: true,
        label: 'Name',
        labelAr: '',
        maxLength: 201,
        required: false,
      }).success
    ).toBe(false);
    // Off with no label is fine (merchant switched it off).
    expect(personalisationConfigSchema.safeParse({ enabled: false, maxLength: 20 }).success).toBe(
      true
    );
  });

  it('falls back to arabic', () => {
    const cfg = {
      enabled: true,
      label: '',
      labelAr: 'الاسم على الطوق',
      maxLength: 20,
      required: false,
    };
    expect(personalisationLabel(cfg, 'en')).toBe('الاسم على الطوق');
    expect(personalisationLabel({ ...cfg, label: 'Collar name', labelAr: '' }, 'ar')).toBe(
      'Collar name'
    );
  });

  it('activePersonalisation is null when off, absent or malformed', () => {
    expect(activePersonalisation(null)).toBeNull();
    expect(activePersonalisation({ enabled: false, label: 'x', maxLength: 5 })).toBeNull();
    expect(
      activePersonalisation({ enabled: true, label: '', labelAr: '', maxLength: 5 })
    ).toBeNull();
    expect(activePersonalisation('nope')).toBeNull();
    expect(activePersonalisation({ enabled: true, label: 'Name', maxLength: 5 })?.maxLength).toBe(
      5
    );
  });
});
