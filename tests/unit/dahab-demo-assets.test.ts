/**
 * Phase B5 Task 5, Rulings B5-2 and B5-11: the committed Dahab demo images are unbranded, within the
 * byte budget, and contain no orange (Ahmad 2026-10-16). `orange-probe.py` is the STRICT probe: a pixel
 * counts when its hue is 12-50 degrees, HSV saturation >= 0.35 and value >= 0.15, and a file over 2 % of
 * the sampled pixels fails. Yellow gold would fail it (FLUX paints it at saturation 0.5-0.8), so the
 * gold-toned pieces are graded to a pale champagne by `grade.py` (saturation capped at 0.30 inside the
 * band). A negative control proves the probe can fail (orange, saffron, amber, brass and terracotta
 * fixtures must exceed the limit); a positive control proves it does not reject what the shop sells
 * (silver, white, emerald, rose, champagne, pearl).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs data module
import { DAHAB_IMAGE_FILES } from '../../scripts/dahab-demo/catalogue.mjs';

const dir = path.resolve(__dirname, '../../scripts/dahab-demo/assets');
const probe = path.resolve(__dirname, '../../scripts/dahab-demo/orange-probe.py');
const KB = 1024;
const files = readdirSync(dir).filter(f => f.endsWith('.webp'));

/**
 * The probe decodes webp with `dwebp` (libwebp-tools). The self-hosted CI runner does not have it
 * (Ruling SOUQ-CI-1, same here), so on CI only the real-image sweep is skipped; everywhere else a
 * missing `dwebp` fails the sweep (fail closed), and the pre-push gate on the Mac runs it.
 */
const dwebpMissing = spawnSync('dwebp', ['-version']).status !== 0;
const skipSweepOnCi = dwebpMissing && Boolean(process.env.CI);

const run = (args: string[]) =>
  spawnSync('python3', ['-I', probe, ...args], { encoding: 'utf8', timeout: 120_000 });

/** A solid P6 ppm of one colour (the negative control and the clean control). */
function ppm(rgb: [number, number, number], w = 30, h = 30): string {
  const dirp = mkdtempSync(path.join(tmpdir(), 'dahab-probe-'));
  const f = path.join(dirp, `fixture-${rgb.join('-')}.ppm`);
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) body.set(rgb, i * 3);
  writeFileSync(f, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), body]));
  return f;
}

describe('dahab demo assets: files', () => {
  it('exactly the images the catalogue and the home document name', () => {
    expect([...files].sort()).toEqual([...DAHAB_IMAGE_FILES].sort());
  });
  it('every file is a WebP, <= 140 KB (heroes -2k: <= 400 KB)', () => {
    for (const f of files) {
      const buf = readFileSync(path.join(dir, f));
      expect(buf.subarray(0, 4).toString('latin1'), f).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('latin1'), f).toBe('WEBP');
      expect(statSync(path.join(dir, f)).size, f).toBeLessThanOrEqual(
        /-2k\.webp$/.test(f) ? 400 * KB : 140 * KB
      );
    }
  });
  it('the whole set is <= 3 MB', () => {
    const total = files.reduce((n, f) => n + statSync(path.join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(3 * 1024 * KB);
  });
  it('no file name is a logo or a brand', () => {
    for (const f of files) expect(f).not.toMatch(/logo|brand/i);
  });
  it('credits, prompts and the pipeline exist, the raw generator output is not committed, the Unsplash set is gone', () => {
    const here = path.resolve(__dirname, '../../scripts/dahab-demo');
    expect(readdirSync(here)).toEqual(
      expect.arrayContaining([
        'CREDITS.md',
        'prompts.py',
        'gen.py',
        'grade.py',
        'encode.sh',
        'orange-probe.py',
        'catalogue.mjs',
        'assets',
      ])
    );
    const tracked = execFileSync('git', ['ls-files', 'scripts/dahab-demo'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    });
    expect(tracked).not.toMatch(/img-src|\.jpg|\.raw/);
    expect(readFileSync(path.join(here, 'CREDITS.md'), 'utf8')).not.toMatch(/unsplash/i);
  });
  it('the prompts forbid marks and people and name no brand or hallmark', () => {
    const prompts = readFileSync(
      path.resolve(__dirname, '../../scripts/dahab-demo/prompts.py'),
      'utf8'
    );
    expect(prompts).toMatch(/no lettering/);
    expect(prompts).toMatch(/no people/);
    expect(prompts).not.toMatch(/bullion|tiffany|cartier|pandora|hallmark stamp of/i);
  });
});

describe('orange-probe.py (strict)', () => {
  it('negative control: orange, saffron, amber, brass and terracotta all FAIL (the gate can fail)', () => {
    const r = run([ppm([230, 130, 69])]); // the lantern orange the Souq design first used
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout.trim()).share).toBeGreaterThan(0.9);
    expect(run([ppm([200, 155, 60])]).status).toBe(1); // brass as FLUX paints it
    expect(run([ppm([224, 165, 38])]).status).toBe(1); // saffron #E0A526
    expect(run([ppm([205, 100, 45])]).status).toBe(1); // saturated terracotta
    expect(run([ppm([212, 175, 55])]).status).toBe(1); // yellow gold: the colour the grade removes
  });
  it('the probe is STRICT: a food brown that Lamma forgives fails here', () => {
    expect(run([ppm([160, 110, 60])]).status).toBe(1);
  });
  it('positive control: silver, white, emerald, rose gold, champagne, pearl and grey pass', () => {
    for (const rgb of [
      [196, 199, 204], // silver
      [255, 255, 255],
      [14, 92, 70], // the Gift box emerald
      [201, 165, 160], // rose gold swatch
      [217, 212, 197], // champagne swatch
      [240, 230, 222], // pearl
      [200, 200, 200],
      [15, 76, 74], // the Workshop teal
    ] as [number, number, number][]) {
      const r = run([ppm(rgb)]);
      expect(r.status, rgb.join(',')).toBe(0);
    }
  });
  it('an undecodable file is an error (exit 2), never a pass', () => {
    const dirp = mkdtempSync(path.join(tmpdir(), 'dahab-probe-'));
    const bad = path.join(dirp, 'broken.webp');
    writeFileSync(bad, 'not a webp');
    expect(run([bad]).status).toBe(2);
  });
  it.skipIf(skipSweepOnCi)(
    'every committed image is within its orange limit (2 % images, 2 % heroes)',
    () => {
      let out = '';
      try {
        out = execFileSync('python3', ['-I', probe, ...files.map(f => path.join(dir, f))], {
          encoding: 'utf8',
          timeout: 240_000,
        });
      } catch (e) {
        out = (e as { stdout?: string }).stdout ?? '';
        throw new Error(`orange probe failed:\n${out}`);
      }
      const rows = out
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as { file: string; share: number; limit: number; ok: boolean });
      expect(rows).toHaveLength(files.length);
      for (const r of rows) {
        expect(r.ok, `${r.file} ${r.share}`).toBe(true);
        expect(r.limit).toBe(0.02);
      }
    },
    300_000
  );
});
