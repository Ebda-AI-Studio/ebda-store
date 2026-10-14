import { describe, it, expect } from 'vitest';
import { LOOKS, LOOK_TEMPLATES, getLook, looksForTemplate, TEMPLATE_FAMILIES } from '@force/shared';

describe('looks registry', () => {
  it('has exactly 3 looks per template, 15 total, unique ids', () => {
    expect(LOOKS).toHaveLength(15);
    expect(new Set(LOOKS.map(l => l.id)).size).toBe(15);
    for (const t of LOOK_TEMPLATES) expect(looksForTemplate(t)).toHaveLength(3);
  });
  it('every look id is <template>.<slug> and matches its template', () => {
    for (const l of LOOKS) expect(l.id.startsWith(`${l.template}.`)).toBe(true);
  });
  it('every look maps to an existing template family', () => {
    const fam = new Set(TEMPLATE_FAMILIES.map(f => f.id));
    for (const l of LOOKS) expect(fam.has(l.template)).toBe(true);
  });
  it('bilingual names and a bold idea on every look', () => {
    for (const l of LOOKS) {
      for (const [k, v] of Object.entries({
        'name.ar': l.name.ar,
        'name.en': l.name.en,
        'forWhom.ar': l.forWhom.ar,
        'forWhom.en': l.forWhom.en,
        'idea.ar': l.idea.ar,
        'idea.en': l.idea.en,
      })) {
        expect(typeof v, `${l.id} ${k}`).toBe('string');
        expect(v.trim().length, `${l.id} ${k}`).toBeGreaterThan(0);
      }
    }
  });
  it('each template has looks lettered exactly A, B, C', () => {
    for (const t of LOOK_TEMPLATES)
      expect(
        looksForTemplate(t)
          .map(l => l.letter)
          .sort()
      ).toEqual(['A', 'B', 'C']);
  });
  it('getLook resolves ids and rejects unknown/empty', () => {
    expect(getLook('qamar.atelier')?.name.en).toBe('Atelier');
    expect(getLook('qamar.nope')).toBeUndefined();
    expect(getLook(null)).toBeUndefined();
  });
});
