import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brandMarkSvg, brandAppIconSvg } from '@ebda/shared';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p));

describe('Ebda logo (2026-10-22 pack)', () => {
  it('every installed gold mark is the approved master, byte for byte', () => {
    const master = read('brand/logo/svg/03d-symbol-gold.svg').toString();
    for (const app of ['admin', 'orders', 'web', 'marketing']) {
      expect(read(`apps/${app}/public/logo.svg`).toString(), app).toBe(master);
    }
  });

  it('the hosted email logo is a PNG that fits whole inside the 160x64 email logo box', () => {
    const png = read('apps/marketing/public/email-logo.png');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    // layout scales it into 160x64 proportionally (never cropped); it must not need upscaling.
    expect(w / h).toBeLessThan(160 / 64 + 0.01);
    expect(h).toBeGreaterThanOrEqual(64);
    expect(w).toBeGreaterThanOrEqual(34);
  });

  it('inline marks carry the new gradient doorway, not the retired arch', () => {
    expect(brandMarkSvg()).toContain('ebda-mark-lint');
    expect(brandAppIconSvg()).toContain('ebda-mark-left');
  });

  it('no source or public asset still draws the retired arch mark', () => {
    const OLD = 'M30 100 V56 a28 28 0 0 1 56 0 V100';
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', '.next', 'dist', '.open-next', 'graphify-out', '.git'].includes(name))
          continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(svg|ts|tsx|mjs|js)$/.test(name) && !p.endsWith('brand-logo-assets.test.ts'))
          if (readFileSync(p, 'utf8').includes(OLD)) hits.push(p.replace(root, ''));
      }
    };
    for (const d of ['apps', 'packages', 'brand', 'scripts']) walk(join(root, d));
    expect(hits).toEqual([]);
  });
});
