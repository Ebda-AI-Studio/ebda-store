/**
 * The marketing 3D section (Ruling MKT-2): the committed assets are the ones the code expects
 * (valid for the product's own validator, meshopt not Draco, small), the licence credit exists in
 * CREDITS.md AND on the /credits page linked from the footer (never under the viewer, MKT-12), the build-time QR codes are fresh, the phone skins mirror the
 * looks they claim, and the viewer's Tailwind classes are all defined in the marketing CSS shim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateGlb } from '../../packages/shared/src/model3d';
import {
  MODEL3D,
  MODEL3D_IDS,
  arPageUrl,
  qrPath,
  stillBase,
} from '../../apps/marketing/src/lib/model3d';
import { qrTargets, renderQr } from '../../apps/marketing/src/lib/model3d-qr';
import { COPY } from '../../apps/marketing/src/lib/content';
import { MODEL_CREDITS } from '../../apps/marketing/src/lib/credits';
import { CreditsPage } from '../../apps/marketing/src/components/CreditsPage';
import { Footer } from '../../apps/marketing/src/components/Footer';
import { Home } from '../../apps/marketing/src/components/Home';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const MK = path.resolve(__dirname, '../../apps/marketing');
const pub = (p: string) => path.join(MK, 'public', p);

describe('3D assets', () => {
  for (const id of MODEL3D_IDS) {
    it(`${id}: the GLB passes the product's validator, is meshopt + WebP (no Draco) and under 1.6 MB`, () => {
      const file = pub(MODEL3D[id].glb);
      expect(statSync(file).size).toBeLessThan(1.6 * 1024 * 1024);
      const r = validateGlb(new Uint8Array(readFileSync(file)));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.stats.extensionsUsed).toContain('EXT_meshopt_compression');
      expect(r.stats.extensionsUsed).not.toContain('KHR_draco_mesh_compression');
      // the colour swatches are the file's own KHR_materials_variants, by name
      expect(r.gltfVariants).toEqual(MODEL3D[id].variants.map(v => v.id));
    });
  }
  it('every still the section can show exists in both formats', () => {
    const bases = new Set<string>();
    for (const id of MODEL3D_IDS)
      for (const v of MODEL3D[id].variants.length ? MODEL3D[id].variants.map(x => x.id) : [null])
        bases.add(stillBase(id, v));
    expect(bases.size).toBe(5); // three sneaker colourways + the lantern + the clay pot
    for (const b of bases)
      for (const ext of ['webp', 'avif']) expect(existsSync(pub(`${b}.${ext}`))).toBe(true);
  });
});

describe('licence credits (Ruling MKT-12)', () => {
  it('CREDITS.md credits Shopify (CC BY 4.0) and Poly Haven (CC0) for all three models', () => {
    const c = readFileSync(pub('demo/CREDITS.md'), 'utf8');
    expect(c).toMatch(/qamar-sneaker\.glb.*Shopify.*CC BY 4\.0/);
    expect(c).toMatch(/brass-diya-lantern\.glb.*Bhargav Kubal.*CC0/);
    expect(c).toMatch(/lamma-clay-pot\.glb.*Aron Łyczek.*CC0/);
  });
  it('every shipped model has a credit entry with author, licence link and a statement of changes', () => {
    for (const id of MODEL3D_IDS) {
      const file = MODEL3D[id].glb.split('/').pop()!;
      const m = MODEL_CREDITS.find(x => x.file === file);
      expect(m, `${file} has no credit`).toBeTruthy();
      expect(m!.author).toBeTruthy();
      expect(m!.licenseUrl).toMatch(/^https:\/\/creativecommons\.org\//);
      expect(m!.changes.ar.length).toBeGreaterThan(10);
      expect(m!.changes.en.length).toBeGreaterThan(10);
    }
    expect(MODEL_CREDITS.find(m => m.author === 'Shopify')?.license).toBe('CC BY 4.0');
  });
  it('the /credits page names Shopify, CC BY 4.0, links the licence and says it was modified, in both languages', () => {
    for (const l of ['ar', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(CreditsPage, { locale: l }));
      expect(html).toContain('Shopify');
      expect(html).toContain('CC BY 4.0');
      expect(html).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
      expect(html).toContain('MaterialsVariantsShoe');
      expect(html).toContain(l === 'ar' ? 'معدّل' : 'modified');
      for (const m of MODEL_CREDITS) expect(html).toContain(`data-credit="${m.file}"`);
    }
  });
  it('every footer links to the credits page, and the home page no longer shows a credit under the viewer', () => {
    for (const [l, href, label] of [
      ['ar', '/credits/', 'حقوق الصور والموديلات'],
      ['en', '/en/credits/', 'Credits'],
    ] as const) {
      const footer = renderToStaticMarkup(createElement(Footer, { locale: l }));
      expect(footer).toMatch(
        new RegExp(`<a href="${href.replace(/\//g, '\\/')}?"[^>]*>${label}</a>`)
      );
      const home = renderToStaticMarkup(createElement(Home, { locale: l }));
      expect(home).not.toContain('m3d-credit');
      expect(home).not.toMatch(/CC BY 4\.0/);
    }
  });
});

describe('desktop QR codes', () => {
  it('are committed, fresh, and each encodes its locale + vertical page URL', async () => {
    expect(qrTargets()).toHaveLength(6);
    for (const t of qrTargets()) {
      expect(readFileSync(pub(t.path), 'utf8')).toBe(await renderQr(t.url));
    }
    expect(arPageUrl('ar', 'souq')).toBe('https://ebda.app/?m=souq#model3d');
    expect(arPageUrl('en', 'qamar')).toBe('https://ebda.app/en/?m=qamar#model3d');
    expect(qrPath('en', 'lamma')).toBe('/3d/qr/lamma-en.svg');
  });
});

describe('phone skins', () => {
  it('mirror the theme tokens of the real look they claim (public/looks, MKT-PHONES-1)', () => {
    const hex = (triple: string) => {
      const [h, s, l] = triple.split(/\s+/).map(x => parseFloat(x));
      const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
      const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255)
          .toString(16)
          .padStart(2, '0');
      };
      return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
    };
    for (const id of MODEL3D_IDS) {
      const { skin } = MODEL3D[id];
      const [tpl, letter] = skin.look.split('-');
      const looks = readFileSync(pub(`looks/${tpl}.html`), 'utf8')
        .split('<!--look-->')
        .slice(1);
      const block = looks['abc'.indexOf(letter)];
      const style = block
        .match(/class="x-root[^"]*"[^>]*style="([^"]*)"/)![1]
        .replace(/&quot;/g, '"');
      const v = Object.fromEntries(
        [...style.matchAll(/--([a-z-]+):\s*([^;]+);?/g)].map(m => [m[1], m[2]])
      );
      expect(skin.bg, `${id} bg`).toBe(hex(v.background));
      expect(skin.ink, `${id} ink`).toBe(hex(v.foreground));
      expect(skin.mut, `${id} mut`).toBe(hex(v['muted-foreground']));
      expect([hex(v.accent), hex(v.primary)], `${id} ac`).toContain(skin.ac);
      expect(v['font-display'], `${id} fd`).toContain(`"${skin.fd}"`);
      expect(v['font-body'], `${id} fb`).toContain(`"${skin.fb}"`);
    }
  });
});

describe('viewer CSS shim', () => {
  it('defines every Tailwind class the product viewer renders, scoped to .m3d', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../packages/ui/src/model3d/ProductModelViewer.tsx'),
      'utf8'
    );
    const css = readFileSync(path.join(MK, 'src/app/globals.css'), 'utf8');
    const classes = new Set<string>();
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g))
      for (const c of (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/))
        if (c) classes.add(c);
    // canvas.className = '...'
    for (const m of src.matchAll(/canvas\.className = '([^']*)'/g))
      for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
    expect(classes.size).toBeGreaterThan(30);
    const esc = (c: string) => c.replace(/([.\[\]/:])/g, '\\$1');
    const missing = [...classes].filter(c => !css.includes(`.m3d .${esc(c)}`));
    expect(missing).toEqual([]);
  });
});
