/**
 * Ebda is a fork of FWB (Force Website Builder, a Force AI / Kuwait product).
 * No FWB / Force AI brand string may survive in anything that ships to a user:
 * app source, public assets (manifests, SVGs, workers) and package source.
 * Brand values come from `BRAND` in packages/shared/src/brand — see
 * docs/TWIN-PATHS.md for how the two codebases relate.
 *
 * Scope: text files under apps/<app>/src, apps/<app>/public, apps/<app>/content
 * (the docs/help MDX that ships to users) and packages/<pkg>/src. docs/, tests/, scripts/ and migrations are NOT scanned
 * (inherited FWB docs / immutable history live there on purpose).
 *
 * To cite upstream in a comment, add the file to ALLOWLIST with a reason.
 * Keep it short — every entry is a place the fork still names FWB.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FORBIDDEN = /Force AI|ForceAI|Force Website Builder|force-ai\.co|forcemediakw|Force Media/i;

/** repo-relative path -> why it may still name the upstream product. */
const ALLOWLIST: Record<string, string> = {};

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', 'dist', '.turbo', 'coverage']);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.css', '.scss',
  '.html', '.svg', '.md', '.mdx', '.txt', '.webmanifest', '.xml', '.yml', '.yaml', '.sql', '.prisma',
]); // prettier-ignore

function roots(): string[] {
  const out: string[] = [];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(ROOT, group);
    for (const name of readdirSync(dir)) {
      const subs = group === 'apps' ? ['src', 'public', 'content'] : ['src'];
      for (const sub of subs) {
        const p = path.join(dir, name, sub);
        try {
          if (statSync(p).isDirectory()) out.push(p);
        } catch {
          /* app without that dir */
        }
      }
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), acc);
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const files = roots().flatMap(r => walk(r));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('no FWB / Force AI branding in shipped sources', () => {
  it('actually scans the app and package sources (not an empty-set pass)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some(f => rel(f).startsWith('apps/admin/public/'))).toBe(true);
    expect(files.some(f => rel(f) === 'packages/shared/src/brand/index.ts')).toBe(true);
  });

  it('the pattern catches each forbidden form', () => {
    for (const s of ['Force AI', 'forceai', 'Force Website Builder', 'x.force-ai.co', 'a.forcemediakw.com', 'force media']) {
      expect(FORBIDDEN.test(s), s).toBe(true);
    }
    expect(FORBIDDEN.test('Ebda by Whisky 11')).toBe(false);
  }); // prettier-ignore

  it('no file names the upstream brand, domain or company', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) in ALLOWLIST) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line))
          offenders.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      offenders,
      'FWB/Force AI branding found. Use BRAND from @force/shared (packages/shared/src/brand) or, for a comment that must cite upstream, add the file to ALLOWLIST in this test with a reason.'
    ).toEqual([]);
  });

  it('every allowlist entry is still needed', () => {
    for (const file of Object.keys(ALLOWLIST)) {
      const src = readFileSync(path.join(ROOT, file), 'utf8');
      expect(FORBIDDEN.test(src), `${file} no longer names upstream — drop it from ALLOWLIST`).toBe(
        true
      );
    }
  });
});
