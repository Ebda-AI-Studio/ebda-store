/**
 * QA-B4 (2026-11-11): Ahmad rejects emoji in UI copy; admin buttons carried ✨ and ⚖️ as their icon.
 * Controls use SVG icons (components/SparkleIcon.tsx, BalanceIcon.tsx) that follow the text colour.
 *
 * Fails when apps/admin/src has a pictographic character in JSX text or an admin message string, outside
 * code comments. `ALLOWED` lists the decorative status glyphs that are not button labels; it may only shrink.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/admin/src');
// Real emoji only (colour pictographs, variation selector, ✨ ⚖ ⚡ ⭐). Plain text marks such as ✓ ✕ ✎ stay legal.
const EMOJI = /\p{Emoji_Presentation}|\uFE0F|[\u2728\u2696\u26A1\u2B50]/u;

/** Not button labels: notification-type and plan glyph maps, answer-engine status marks. */
const ALLOWED = new Set([
  'components/NotificationBell.tsx',
  'app/stores/_components/types.ts',
  'app/stores/[id]/answer-engine/_components/PromptResultsList.tsx',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.next') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|json)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('no emoji in admin controls (QA-B4)', () => {
  it('has no pictographic character in admin code or messages outside comments and ALLOWED', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\/\/.*$/, '');
          if (!rel.endsWith('.json') && /^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (EMOJI.test(rel.endsWith('.json') ? line : code)) hits.push(`${rel}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
