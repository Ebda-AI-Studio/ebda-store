/**
 * Phase B2 Task 6, Ruling B2-10: the committed Souq demo images are unbranded, within the byte
 * budget, and contain no orange (Ruling B2-2). `orange-probe.py` measures the share of pixels with
 * hue 12-50, saturation >= 0.35, value >= 0.25 (<= 3 % per image, <= 5 % per hero); a negative
 * control proves the probe can fail (an orange fixture must exceed the limit).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs data module
import { SOUQ_IMAGE_FILES } from '../../scripts/souq-demo/catalogue.mjs';

const dir = path.resolve(__dirname, '../../scripts/souq-demo/assets');
const probe = path.resolve(__dirname, '../../scripts/souq-demo/orange-probe.py');
const KB = 1024;
const files = readdirSync(dir).filter(f => f.endsWith('.webp'));

/**
 * The probe decodes webp with `dwebp` (libwebp-tools). The self-hosted CI runner does not have it
 * (Ruling SOUQ-CI-1), so on CI only the real-image sweep is skipped; everywhere else a missing
 * `dwebp` fails the sweep (fail closed), and the pre-push gate on the Mac runs it.
 */
const dwebpMissing = spawnSync('dwebp', ['-version']).status !== 0;
const skipSweepOnCi = dwebpMissing && Boolean(process.env.CI);

const run = (args: string[]) =>
  spawnSync('python3', ['-I', probe, ...args], { encoding: 'utf8', timeout: 120_000 });

/** A solid P6 ppm of one colour (the negative control and the clean control). */
function ppm(rgb: [number, number, number], w = 30, h = 30): string {
  const dirp = mkdtempSync(path.join(tmpdir(), 'souq-probe-'));
  const f = path.join(dirp, `fixture-${rgb.join('-')}.ppm`);
  const body = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) body.set(rgb, i * 3);
  writeFileSync(f, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), body]));
  return f;
}

describe('souq demo assets: files', () => {
  it('exactly the images the catalogue and the home document name', () => {
    expect([...files].sort()).toEqual([...SOUQ_IMAGE_FILES].sort());
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
  it('the whole set is <= 7 MB', () => {
    const total = files.reduce((n, f) => n + statSync(path.join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(7 * 1024 * KB);
  });
  it('no file name is a logo or a brand', () => {
    for (const f of files) expect(f).not.toMatch(/logo|brand/i);
  });
});

describe('orange-probe.py', () => {
  it('negative control: an orange image FAILS (the gate can fail)', () => {
    const r = run([ppm([230, 130, 69])]); // the lantern orange Night souq first used
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout.trim()).share).toBeGreaterThan(0.9);
    expect(run([ppm([200, 155, 60])]).status).toBe(1); // the brass
  });
  it('positive control: turquoise, pomegranate and grey pass', () => {
    for (const rgb of [
      [95, 211, 192],
      [232, 96, 106],
      [200, 200, 200],
    ] as [number, number, number][]) {
      const r = run([ppm(rgb)]);
      expect(r.status, rgb.join(',')).toBe(0);
    }
  });
  it('an undecodable file is an error (exit 2), never a pass', () => {
    const dirp = mkdtempSync(path.join(tmpdir(), 'souq-probe-'));
    const bad = path.join(dirp, 'broken.webp');
    writeFileSync(bad, 'not a webp');
    expect(run([bad]).status).toBe(2);
  });
  it.skipIf(skipSweepOnCi)(
    'every committed image is within its orange limit (3 % images, 5 % heroes)',
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
        expect(r.limit).toBe(r.file.startsWith('hero') ? 0.05 : 0.03);
      }
    },
    300_000
  );
});
