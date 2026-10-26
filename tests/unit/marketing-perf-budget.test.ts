import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The marketing perf budget script (marketing-levelup P2): it fails a page that loads too much JS up front. */
const SCRIPT = path.resolve(__dirname, '../../scripts/ci/marketing-perf-budget.mjs');

function site(jsBytes: number) {
  const out = mkdtempSync(path.join(tmpdir(), 'perf-'));
  mkdirSync(path.join(out, '_next', 'static'), { recursive: true });
  // incompressible filler so the gzip size is about the byte count
  const rnd = randomBytes(jsBytes);
  writeFileSync(path.join(out, '_next', 'static', 'app.js'), rnd);
  writeFileSync(
    path.join(out, 'index.html'),
    '<!doctype html><html><head><script src="/_next/static/app.js" async></script></head><body>x</body></html>'
  );
  return out;
}
const run = (out: string) => {
  try {
    return { code: 0, text: execFileSync('node', [SCRIPT, '--out', out], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, text: err.stdout };
  }
};

describe('marketing performance budget', () => {
  it('passes a light page and fails a page over the JS budget (negative control)', () => {
    expect(run(site(50_000)).code).toBe(0);
    const heavy = run(site(300_000));
    expect(heavy.code).toBe(1);
    expect(heavy.text).toMatch(/OVER .*js=.*KB > /);
  });
  it("the real budget file is sane: target 2.5 s, home 205 KB, no page may exceed the plan's 200 KB by more than the home", () => {
    const b = JSON.parse(
      require('node:fs').readFileSync(
        path.resolve(__dirname, '../../scripts/ci/marketing-perf-budget.json'),
        'utf8'
      )
    );
    expect(b.lcpMs).toBe(2500);
    expect(b.lcpGateMs).toBeGreaterThanOrEqual(b.lcpMs);
    expect(b.default.jsGzipKb).toBeLessThanOrEqual(200);
    expect(b.pages['/'].jsGzipKb).toBeLessThanOrEqual(205);
  });
});
