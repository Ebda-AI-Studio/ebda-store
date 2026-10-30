/**
 * Ruling SKIN-DEL-1/8, plan Task 9 (the final gate as a test): the five Force skin names exist in
 * the repo as TemplateId strings in ONE place, `packages/shared/src/templates/legacy-skin-map.ts`
 * (+ its test), the tolerant reader that maps an old persisted value to an Ebda template.
 * Everything else names the set through `RETIRED_TEMPLATES` / `normalizeLegacyTemplate`.
 *
 * Known false positives are listed by file AND line pattern with the reason, so a real
 * leftover never hides behind them: `FontFamily` has its own 'modern', the vibe presets have
 * 'minimal', CSS font weights say 'bold'.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const NAMES = '(modern|elegant|classic|minimal|bold)';

const files = execFileSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    'apps',
    'packages',
    'tests',
    'scripts',
    '.github',
  ],
  { cwd: root, encoding: 'utf8' }
)
  .split('\n')
  .filter(f => /\.(ts|tsx|js|jsx|mjs|cjs|yml|yaml)$/.test(f))
  .filter(f => !f.includes('/migrations/') && !f.endsWith('/node_modules'))
  // a minified third-party library build (exceljs, Ruling BUNDLE-BUDGET-6), not first-party source
  .filter(f => f !== 'apps/api/src/cf/stubs/exceljs-workers.cjs');

// The one place that may carry the names (the tolerant reader and its own test).
const READER = [
  'packages/shared/src/templates/legacy-skin-map.ts',
  'packages/shared/src/templates/legacy-skin-map.test.ts',
];
// This test file spells the names to search for them.
const SELF = 'tests/unit/no-retired-skin-strings.test.ts';

/** file -> [line pattern, reason]. A hit must match one of its file's patterns. */
const FALSE_POSITIVES: Record<string, Array<[RegExp, string]>> = {
  'packages/shared/src/types/store-theme.ts': [[/FontFamily = /, 'FontFamily has its own modern']],
  'packages/shared/src/builder/settings-schema.ts': [[/opt\('modern'/, 'FontFamily option']],
  'apps/admin/src/app/stores/[id]/branding/_components/types.ts': [
    [/value: 'modern', key: 'modern'/, 'FontFamily option'],
  ],
  'packages/database/prisma/seed.ts': [[/fontFamily: 'modern'/, 'FontFamily value']],
  'packages/database/prisma/seed-loadtest-stores.ts': [
    [/fontFamily: 'modern'/, 'FontFamily value'],
  ],
  'tests/e2e/store.test.ts': [[/fontFamily: 'modern'/, 'FontFamily value']],
  'packages/shared/src/utils/vibe-presets.ts': [[/\| 'minimal'/, 'VibeId']],
  'apps/admin/src/components/SmartPaletteModal.tsx': [[/^\s*'minimal',$/, 'VibeId']],
  'packages/shared/src/types/typography.ts': [
    [/font-weight: `400`, `600`, `bold`/, 'CSS font-weight'],
  ],
  'apps/admin/src/app/stores/[id]/builder/_components/ThemeSettingsPanel.test.tsx': [
    [/\['classic', 'Only'\]/, 'copy-gate absence check for the classic builder'],
  ],
  'packages/cf-schema/src/platform/schema.generated.ts': [
    [
      /^\s*'(modern|classic|minimal|bold|elegant)',$/,
      'the Prisma StoreTemplate enum mirrored by the generated cf-schema: persisted values the tolerant reader maps',
    ],
  ],
  'packages/cf-schema/src/store/schema.generated.ts': [
    [
      /^\s*'(modern|classic|minimal|bold|elegant)',$/,
      'the Prisma StoreTemplate enum mirrored by the generated cf-schema: persisted values the tolerant reader maps',
    ],
  ],
  'tests/unit/editor-matrix.test.ts': [[/\?\? 'classic'/, 'the classic builder capability label']],
};

function hitsOf(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (READER.includes(f) || f === SELF) continue;
    const lines = readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      const allowed = (FALSE_POSITIVES[f] ?? []).some(([p]) => p.test(line));
      if (!allowed) out.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return out;
}

describe('no retired Force skin name outside the tolerant reader', () => {
  it('no quoted skin id (plan Task 9, command 1)', () => {
    expect(hitsOf(new RegExp(`['"\`]${NAMES}['"\`]`))).toEqual([]);
  });

  it('no skin directory, relative import or data-pack selector (plan Task 9, commands 2 and 3)', () => {
    expect(
      hitsOf(
        new RegExp(
          `templates/${NAMES}\\b|\\.\\./${NAMES}/|\\./${NAMES}['/]|/minimal/|data-pack=.?${NAMES}`
        )
      )
    ).toEqual([]);
  });

  it('the allowlisted reader still names all five (the test cannot pass by deleting it)', () => {
    const src = readFileSync(path.join(root, READER[0]!), 'utf8');
    for (const n of ['modern', 'classic', 'minimal', 'bold', 'elegant'])
      expect(src).toContain(`'${n}'`);
  });

  it('the false-positive table has no stale entry (each pattern still matches its file)', () => {
    for (const [f, entries] of Object.entries(FALSE_POSITIVES)) {
      const text = readFileSync(path.join(root, f), 'utf8');
      for (const [p, reason] of entries)
        expect(p.test(text) || text.split('\n').some(l => p.test(l)), `${f}: ${reason}`).toBe(true);
    }
  });
});
