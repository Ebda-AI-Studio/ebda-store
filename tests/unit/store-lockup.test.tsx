import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LOCKUPS, LOOKS, lockupFor, lockupLatin } from '@ebda/shared';
import { StoreLockup } from '../../apps/web/src/templates/shared/StoreLockup';

describe('built-in store lockup (G1)', () => {
  it('every built look has a lockup, and a template with no look gets its first look', () => {
    for (const l of LOOKS.filter(l => l.status === 'built'))
      expect(LOCKUPS[l.id], l.id).toBeTruthy();
    expect(lockupFor(null, 'dahab')).toBe(LOCKUPS['dahab.worn']);
    expect(lockupFor('souq.night', 'souq')).toBe(LOCKUPS['souq.night']);
    expect(lockupFor(null, 'no-such-skin' as never)).toBeNull();
  });

  it('the Latin line is the uppercased Latin name, a fixed text, or nothing', () => {
    expect(lockupLatin(LOCKUPS['qamar.atelier'], 'Qamar')).toBe('QAMAR');
    expect(lockupLatin(LOCKUPS['dahab.workshop'], 'Dahab')).toBe('DAHAB · SILVER');
    expect(lockupLatin(LOCKUPS['qamar.atelier'], 'قمر')).toBeNull(); // no Latin form: never invented
    expect(lockupLatin(LOCKUPS['lamma.market'], 'Lamma')).toBeNull(); // the look sets no Latin line
  });

  it('renders the Arabic name large with the tracked Latin line under it (stack) or beside it (inline)', () => {
    const s = renderToStaticMarkup(
      <StoreLockup lockup={LOCKUPS['qamar.atelier']} name="Qamar" nameAr="قمر" isRtl />
    );
    expect(s).toContain('قمر');
    expect(s).toContain('QAMAR');
    expect(s).toContain('flex-col');
    expect(s).toContain('font-size:36px');
    expect(s).toContain('letter-spacing:0.34em');
    const inline = renderToStaticMarkup(
      <StoreLockup lockup={LOCKUPS['souq.catalogue']} name="Souq" nameAr="سوق" isRtl />
    );
    expect(inline).toContain('flex-row');
    expect(inline).toContain('SOUQ');
  });

  it('in English the name stands alone (no second Latin line) and the Latin line is aria-hidden', () => {
    const en = renderToStaticMarkup(
      <StoreLockup lockup={LOCKUPS['qamar.atelier']} name="Qamar" nameAr="قمر" isRtl={false} />
    );
    expect(en).not.toContain('QAMAR');
    const ar = renderToStaticMarkup(
      <StoreLockup lockup={LOCKUPS['qamar.atelier']} name="Qamar" nameAr="قمر" isRtl />
    );
    expect(ar).toMatch(/aria-hidden="true"[^>]*>QAMAR/);
  });

  it('PREMIUM-30: the Latin line never truncates with an ellipsis, keeps its tracking on an Arabic page, and does not shrink its box', () => {
    const ar = renderToStaticMarkup(
      <StoreLockup lockup={LOCKUPS['qamar.atelier']} name="Qamar" nameAr="قمر" isRtl />
    );
    const latin = ar.slice(ar.indexOf('aria-hidden="true"'));
    expect(latin).not.toContain('text-ellipsis');
    expect(latin).toContain('lang="en"'); // :lang(ar) * resets tracking; the Latin word is exempt
    expect(latin).toContain('dir="ltr"');
    expect(latin).not.toMatch(/margin-inline-end:calc/); // the negative end margin made the box narrower than the word
    expect(latin).toContain('padding-inline-start:0.34em');
  });

  it('PREMIUM-30: an inline lockup stacks on a phone and returns to a row from md; the display name keeps room for its marks', () => {
    const inline = renderToStaticMarkup(
      <StoreLockup lockup={LOCKUPS['jasmine.bloom']} name="Jasmine" nameAr="ياسمين" isRtl />
    );
    expect(inline).toContain('flex-col');
    expect(inline).toContain('md:flex-row');
    expect(inline).toMatch(/padding-block:0\.3em/);
    expect(inline).toMatch(/margin-block:-0\.3em/);
  });
});
