/**
 * Ahmad 2026-11-09: "on demo stores the hero videos or images are not high res". The demo heroes were
 * 1024x576 stills (FLUX schnell, long edge capped at 1200) served raw from media.ebda.app, so a 1440 px
 * desktop upscaled them 1.4x (2.8x on retina) and the Qamar clip was a 1280x720 zoom of that same still.
 * This guard fixes the floor for EVERY template's hero (and the Qamar lookbook slider heroes): the file
 * must be >= 2000 px wide and within the 400 KB hero budget, and the clip must be 1080p. The key carries
 * a `-2k` marker because media.ebda.app objects are `immutable, max-age=1y`: a re-render under the old
 * key would never reach a visitor who already cached it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const KB = 1024;
const scripts = path.resolve(__dirname, '../../scripts');
const TEMPLATES = ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'];

/** Width x height of a WebP (lossy VP8, lossless VP8L or extended VP8X), read from the header. */
function webpSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  const kind = b.subarray(12, 16).toString('latin1');
  if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error(`${file}: not a WebP`);
}

const heroFiles = TEMPLATES.flatMap(t => {
  const dir = path.join(scripts, `${t}-demo`, 'assets');
  return readdirSync(dir)
    .filter(
      f =>
        f.endsWith('.webp') &&
        (f.startsWith('hero') || (t === 'qamar' && f.startsWith('lookbook-')))
    )
    .map(f => ({ t, f, p: path.join(dir, f) }));
});

describe('demo heroes are high resolution', () => {
  it('every template ships at least one hero', () => {
    for (const t of TEMPLATES)
      expect(
        heroFiles.some(h => h.t === t),
        t
      ).toBe(true);
  });
  it.each(heroFiles.map(h => [`${h.t}/${h.f}`, h] as const))(
    '%s is >= 2000 px wide, 16:9, <= 400 KB, -2k key',
    (_n, h) => {
      const { w, h: ht } = webpSize(h.p);
      expect(w, `${h.f} width`).toBeGreaterThanOrEqual(2000);
      expect(Math.abs(w / ht - 16 / 9), `${h.f} aspect`).toBeLessThan(0.02);
      expect(statSync(h.p).size, `${h.f} bytes`).toBeLessThanOrEqual(400 * KB);
      expect(h.f, 'immutable-cache key marker').toMatch(/-2k\.webp$/);
    }
  );

  const clip = path.join(scripts, 'qamar-demo/assets/hero-1080.mp4');
  const ffprobe = spawnSync('ffprobe', ['-version']).status === 0;
  it('the Qamar hero clip is 1080p, <= 3 MB, with a 540p phone rendition', () => {
    expect(existsSync(clip)).toBe(true);
    expect(statSync(clip).size).toBeLessThanOrEqual(3 * KB * KB);
    const mobile = path.join(scripts, 'qamar-demo/assets/hero-540.mp4');
    expect(existsSync(mobile)).toBe(true);
    expect(statSync(mobile).size).toBeLessThanOrEqual(1 * KB * KB);
    if (!ffprobe) return; // the self-hosted runner has no ffprobe; the size gates above still run
    const dims = (f: string) =>
      spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          f,
        ],
        { encoding: 'utf8' }
      ).stdout.trim();
    expect(dims(clip)).toBe('1920,1080');
    expect(dims(mobile)).toBe('960,540');
  });
});
