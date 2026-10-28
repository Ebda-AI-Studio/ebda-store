import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QR_DESIGN,
  QR_STYLES,
  QR_FINDERS,
  QR_FRAMES,
  buildScene,
  contrastRatio,
  qrLink,
  qrUtm,
  qrDesignSchema,
  rasterizeScene,
  sceneToSvg,
  selfCheck,
  validateColours,
  type QrDesign,
} from '../../packages/shared/src/qr';

const URL1 = 'https://demo-shop.ebda.app/q/s';
const d = (over: Partial<QrDesign> = {}): QrDesign => ({ ...DEFAULT_QR_DESIGN, ...over });

describe('qr contrast', () => {
  it('black on white is 21:1', () =>
    expect(Math.round(contrastRatio('#000000', '#ffffff'))).toBe(21));
  it('flags inverted and low-contrast pairs', () => {
    expect(validateColours('#ffffff', '#000000')).toContain('inverted');
    expect(validateColours('#9a9a9a', '#ffffff')).toContain('low-contrast');
    expect(validateColours('#14110d', '#ffffff')).toEqual([]);
  });
  it('merchants may pick any hue that stays AA (orange is allowed for them)', () => {
    expect(validateColours('#7a2e00', '#ffffff')).toEqual([]);
  });
});

describe('qr links', () => {
  it('builds stateless short links', () => {
    expect(qrLink('store', 'https://a.ebda.app/')).toBe('https://a.ebda.app/q/s');
    expect(qrLink('whatsapp', 'https://a.ebda.app')).toBe('https://a.ebda.app/q/w');
    expect(qrLink('product', 'https://a.ebda.app', 'ring one')).toBe(
      'https://a.ebda.app/q/p/ring%20one'
    );
    expect(qrLink('category', 'https://a.ebda.app', 'خواتم')).toContain('/q/c/%D8%AE');
    expect(() => qrLink('product', 'https://a.ebda.app')).toThrow();
    expect(qrUtm('product')).toBe('utm_source=qr&utm_medium=print&utm_campaign=product');
  });
});

describe('qr scene + self-check', () => {
  it('the default design decodes back to the exact payload', () => {
    const r = selfCheck(URL1, DEFAULT_QR_DESIGN);
    expect(r.ok).toBe(true);
    expect(r.decoded).toBe(URL1);
  });

  for (const style of QR_STYLES)
    for (const finder of QR_FINDERS)
      for (const frame of QR_FRAMES)
        it(`decodes: ${style}/${finder}/${frame}`, () => {
          expect(selfCheck(URL1, d({ style, finder, frame })).ok).toBe(true);
        });

  it('forces ECC high with a logo and still decodes with an empty AND a solid hole', () => {
    const design = d({ logo: true });
    expect(buildScene(URL1, design).ecc).toBe('high');
    expect(buildScene(URL1, d()).ecc).toBe('medium');
    expect(selfCheck(URL1, design).ok).toBe(true);
    const long = 'https://some-long-store-name.ebda.app/q/p/' + 'x'.repeat(60);
    expect(selfCheck(long, d({ logo: true, style: 'dots' })).ok).toBe(true);
  });

  it('keeps the logo hole under 16% of the code area', () => {
    const s = buildScene(URL1, d({ logo: true }));
    expect(s.logo).not.toBeNull();
    expect(s.logo!.size ** 2 / (s.modules * 10) ** 2).toBeLessThanOrEqual(0.16);
  });

  it('blocks low contrast, inverted colours and a code that cannot be read', () => {
    expect(selfCheck(URL1, d({ fg: '#bbbbbb' })).problems).toContain('low-contrast');
    expect(selfCheck(URL1, d({ fg: '#ffffff', bg: '#000000' })).problems).toContain('inverted');
    // a hole far bigger than ECC H can repair must fail the decode
    const scene = buildScene(URL1, d({ logo: true }));
    const bmp = rasterizeScene(scene, 8, { logoFill: { color: '#14110d' } });
    // wipe a big block in the data area
    for (let y = 40; y < bmp.height - 40; y++)
      for (let x = 40; x < bmp.width * 0.7; x++)
        bmp.data.set([255, 255, 255, 255], (y * bmp.width + x) * 4);
    // decoding the damaged bitmap through the same helper must fail
    return import('../../packages/shared/src/qr').then(m =>
      expect(m.decodeBitmap(bmp)).not.toBe(URL1)
    );
  });
});

describe('qr svg + schema', () => {
  it('escapes merchant text in the SVG and only embeds data: logos', () => {
    const design = d({ cta: { text: '</text><script>alert(1)</script>&"', lang: 'en' } });
    const svg = sceneToSvg(buildScene(URL1, design));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    const withLogo = sceneToSvg(buildScene(URL1, d({ logo: true })), 'https://evil.example/x.png');
    expect(withLogo).not.toContain('evil.example');
    expect(withLogo).not.toContain('<image');
    const ok = sceneToSvg(buildScene(URL1, d({ logo: true })), 'data:image/png;base64,AAAA');
    expect(ok).toContain('<image');
  });

  it('rejects, at the API edge, a design that cannot scan (inverted or low contrast)', () => {
    const bad = qrDesignSchema.safeParse({ ...DEFAULT_QR_DESIGN, fg: '#ffffff', bg: '#000000' });
    expect(bad.success).toBe(false);
    expect(qrDesignSchema.safeParse({ ...DEFAULT_QR_DESIGN, fg: '#bbbbbb' }).success).toBe(false);
  });

  it('caps a long call-to-action line to the frame width in the SVG', () => {
    const long = d({ cta: { text: 'ا'.repeat(40), lang: 'ar' } });
    expect(sceneToSvg(buildScene(URL1, long))).toContain('textLength=');
    expect(sceneToSvg(buildScene(URL1, d()))).not.toContain('textLength=');
  });

  it('rejects malformed colours and long call-to-action lines', () => {
    expect(qrDesignSchema.safeParse(DEFAULT_QR_DESIGN).success).toBe(true);
    expect(qrDesignSchema.safeParse({ ...DEFAULT_QR_DESIGN, fg: 'red' }).success).toBe(false);
    expect(
      qrDesignSchema.safeParse({ ...DEFAULT_QR_DESIGN, cta: { text: 'x'.repeat(41), lang: 'en' } })
        .success
    ).toBe(false);
    expect(qrDesignSchema.safeParse({ ...DEFAULT_QR_DESIGN, extra: 1 }).success).toBe(false);
    expect(() => buildScene(URL1, d({ fg: 'url(#x)' }))).toThrow();
  });
});
