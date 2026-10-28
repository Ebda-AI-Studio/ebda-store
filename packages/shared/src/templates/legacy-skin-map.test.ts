import { describe, it, expect } from 'vitest';
import {
  RETIRED_TEMPLATES,
  EBDA_TEMPLATES,
  DEFAULT_EBDA_TEMPLATE,
  mapRetiredSkin,
  isRetiredTemplate,
  isEbdaTemplate,
  mapRetiredTemplate,
  normalizeLegacyTemplate,
} from './legacy-skin-map';
import { LOOKS } from '../looks';

const allBuilt = () => true;
const noneBuilt = () => false;

describe('legacy skin map (Ruling SKIN-DEL-1)', () => {
  it('maps every retired skin to a look that exists in the registry', () => {
    const ids = new Set<string>(LOOKS.map(l => l.id));
    for (const s of RETIRED_TEMPLATES)
      expect(ids.has(mapRetiredSkin(s, { isBuilt: allBuilt }))).toBe(true);
  });

  it('the table', () => {
    const m = (s: (typeof RETIRED_TEMPLATES)[number]) => mapRetiredSkin(s, { isBuilt: allBuilt });
    expect(m('modern')).toBe('souq.catalogue');
    expect(m('elegant')).toBe('qamar.atelier');
    expect(m('classic')).toBe('dahab.worn');
    expect(m('minimal')).toBe('souq.showroom');
    expect(m('bold')).toBe('qamar.lookbook');
  });

  it('falls back to qamar.atelier when the target is not built', () => {
    for (const s of RETIRED_TEMPLATES)
      expect(mapRetiredSkin(s, { isBuilt: noneBuilt })).toBe('qamar.atelier');
  });

  it('defaults to the registry status: every mapped look is built today', () => {
    for (const s of RETIRED_TEMPLATES)
      expect(mapRetiredSkin(s)).toBe(mapRetiredSkin(s, { isBuilt: allBuilt }));
  });

  it('never returns a look whose skin is itself retired', () => {
    for (const s of RETIRED_TEMPLATES) {
      const look = LOOKS.find(l => l.id === mapRetiredSkin(s))!;
      expect(isRetiredTemplate(look.skin)).toBe(false);
    }
  });

  it('every registry look renders on a live template', () => {
    for (const l of LOOKS) expect(isEbdaTemplate(l.skin)).toBe(true);
  });
});

describe('normalizeLegacyTemplate', () => {
  it('a retired value becomes the template of its mapped look', () => {
    expect(normalizeLegacyTemplate('modern')).toBe('souq');
    expect(normalizeLegacyTemplate('elegant')).toBe('qamar');
    expect(normalizeLegacyTemplate('classic')).toBe('dahab');
    expect(normalizeLegacyTemplate('minimal')).toBe('souq');
    expect(normalizeLegacyTemplate('bold')).toBe('qamar');
  });

  it('a live template passes through', () => {
    for (const t of EBDA_TEMPLATES) expect(normalizeLegacyTemplate(t)).toBe(t);
  });

  it('null, undefined, empty and unknown values return the default and never throw', () => {
    for (const v of [null, undefined, '', '  ', 'bogus', 42, {}, []])
      expect(normalizeLegacyTemplate(v)).toBe(DEFAULT_EBDA_TEMPLATE);
  });

  it('is idempotent and its output is always writable', () => {
    for (const v of [...RETIRED_TEMPLATES, ...EBDA_TEMPLATES, 'bogus', null]) {
      const once = normalizeLegacyTemplate(v);
      expect(normalizeLegacyTemplate(once)).toBe(once);
      expect(isRetiredTemplate(once)).toBe(false);
      expect(isEbdaTemplate(once)).toBe(true);
    }
  });
});

describe('mapRetiredTemplate', () => {
  it('maps a retired name and leaves everything else untouched', () => {
    expect(mapRetiredTemplate('bold')).toBe('qamar');
    expect(mapRetiredTemplate('souq')).toBe('souq');
    expect(mapRetiredTemplate('nope')).toBe('nope');
  });
});

describe('a persisted document naming a retired skin still parses', () => {
  it('a revision / theme JSON carrying "template":"elegant" normalizes without throwing', () => {
    const persisted = JSON.parse('{"template":"elegant","appliedLook":null,"sections":[]}') as {
      template: string;
    };
    expect(normalizeLegacyTemplate(persisted.template)).toBe('qamar');
    const theme = JSON.parse('{"template":"modern","primaryColor":"0 0% 9%"}') as {
      template: string;
    };
    expect(normalizeLegacyTemplate(theme.template)).toBe('souq');
  });
});
