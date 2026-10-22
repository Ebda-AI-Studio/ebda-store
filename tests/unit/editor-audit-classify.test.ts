import { describe, it, expect } from 'vitest';
import { classify } from '../../scripts/editor-audit/classify';

describe('classify', () => {
  it('wired needs BOTH a static reader and a differing probe', () => {
    expect(classify({ staticHit: true, probeDiffers: true, shown: true })).toBe('wired');
    expect(classify({ staticHit: true, probeDiffers: false, shown: true })).toBe('no-op');
    expect(classify({ staticHit: false, probeDiffers: true, shown: true })).toBe('no-op');
    expect(classify({ staticHit: false, probeDiffers: false, shown: true })).toBe('no-op');
  });

  it('a control the probe cannot render needs the static reader alone', () => {
    expect(classify({ probeable: false, staticHit: true, shown: true })).toBe('wired');
    expect(classify({ probeable: false, staticHit: false, shown: true })).toBe('no-op');
  });

  it('a variant in the look mix with no control is missing', () => {
    expect(classify({ inMix: true, hasControl: false })).toBe('missing');
    expect(classify({ inMix: true, hasControl: true, staticHit: true, probeDiffers: true })).toBe(
      'wired'
    );
  });

  it('a look whose skin does not exist yet is pending, not failed', () => {
    expect(classify({ lookStatus: 'designed', skinExists: false })).toBe('pending-template');
    // a designed look that renders on an existing skin is classified like any other
    expect(
      classify({ lookStatus: 'designed', skinExists: true, staticHit: true, probeDiffers: true })
    ).toBe('wired');
  });

  it('classic-only and marker-pending are their own statuses', () => {
    expect(classify({ classicOnly: true })).toBe('classic-only');
    expect(classify({ markerMissing: true, lookStatus: 'built', skinExists: true })).toBe(
      'marker-pending'
    );
  });
});
