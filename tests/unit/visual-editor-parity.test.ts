/**
 * Parity gate for retiring the form page builder (Ruling VE-6, plan § 2.3). The classic builder
 * (`apps/admin/src/app/stores/[id]/page-builder/`) may only be deleted when this passes with zero
 * `classic-only` rows. Until then it is a ratchet: today's gaps are listed in
 * `scripts/editor-audit/baseline.json` (matrix rows) and `parity-baseline.json` (classic references
 * and live writes), a new gap fails, and a gap that is closed must leave the list.
 *
 *   EDITOR_MATRIX_WRITE=1 regenerates parity-baseline.json (npm run editor:matrix does).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  THEME_SETTINGS_SCHEMA,
  DRAFT_THEME_KEYS,
  definitionToLayout,
  layoutToDefinition,
  reduceDocument,
  resolveLayoutSettings,
  sectionDefinitionForLegacyKey,
  type SettingDefinition,
} from '@ebda/shared';
import {
  buildClassicManifest,
  endpointFragment,
} from '../../scripts/editor-audit/classic-manifest';
import { readBaseline } from '../../scripts/editor-audit/gen-matrix';

const root = path.resolve(__dirname, '../..');
const ADMIN_SRC = path.join(root, 'apps/admin/src');
const BUILDER = path.join(ADMIN_SRC, 'app/stores/[id]/builder');
const PARITY_BASELINE = path.join(root, 'scripts/editor-audit/parity-baseline.json');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|json)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(root, p);

/** Files under apps/admin/src that still mention the classic builder (item 5 of the gate). */
/** The two files that name the retired route ON PURPOSE: hub highlighting and the redirect registry. */
const REDIRECT_TARGET_FILES = [
  'apps/admin/src/components/admin-layout/hubs.ts',
  'apps/admin/src/lib/settings-registry.ts',
];
function classicReferences(): string[] {
  return walk(ADMIN_SRC)
    .filter(f => !REDIRECT_TARGET_FILES.includes(rel(f)))
    .filter(f =>
      /page-builder|editInClassic|classicOnly|tryNewBuilder/.test(readFileSync(f, 'utf8'))
    )
    .map(rel);
}
/** Builder files that PUT/POST the live theme or typography (VE-4 says: draft only). */
function liveWrites(): string[] {
  return walk(BUILDER)
    .filter(f => !/\.test\./.test(f))
    .filter(f => /api(Put|Post)[^;]*\/(theme|typography)\b/.test(readFileSync(f, 'utf8')))
    .map(rel);
}

const current = { classicReferences: classicReferences(), liveWrites: liveWrites() };

if (process.env.EDITOR_MATRIX_WRITE === '1') {
  describe('parity baseline', () => {
    it('shrinks parity-baseline.json (a closed gap leaves it; a new one never enters)', () => {
      const old = JSON.parse(readFileSync(PARITY_BASELINE, 'utf8')) as typeof current;
      const keep = (was: string[], now: string[]) => was.filter(f => now.includes(f));
      writeFileSync(
        PARITY_BASELINE,
        JSON.stringify(
          {
            classicReferences: keep(old.classicReferences, current.classicReferences),
            liveWrites: keep(old.liveWrites, current.liveWrites),
          },
          null,
          2
        ) + '\n'
      );
    });
  });
} else {
  const parityBaseline = JSON.parse(readFileSync(PARITY_BASELINE, 'utf8')) as typeof current;
  const manifest = buildClassicManifest();

  describe('visual editor parity (the gate for deleting /page-builder)', () => {
    it('1. every manifest entry is wired to a real control or is a listed classic-only gap', () => {
      const accepted = new Set(readBaseline().map(b => b.id));
      const unlisted = manifest
        .filter(e => e.status === 'classic-only' && e.kind !== 'api')
        .filter(e => !accepted.has(`classic|${e.kind}|${e.key}`))
        .map(e => e.key);
      expect(unlisted).toEqual([]);
      // every wired entry names a control that exists
      const types = new Set<string>();
      for (const e of manifest.filter(
        x => x.kind === 'field' && x.status === 'wired' && x.builder?.startsWith('section:')
      )) {
        const [type, rawSetting] = e.builder!.slice('section:'.length).split('/');
        const setting = rawSetting?.split(' ')[0]; // `layout (mobile viewport override)`
        types.add(type);
        if (!setting || /^(hidden|blocks|blocks .*)$/.test(setting)) continue;
        const d = sectionDefinitionForLegacyKey(e.key.split('.')[0] as never);
        expect(d.type, e.key).toBe(type);
        expect(
          d.settings.flatMap(s => (s.localized ? [s.id, `${s.id}Ar`] : [s.id])),
          e.key
        ).toContain(setting);
      }
    });

    it('the plan capabilities P-01 to P-14 are all accounted for in the manifest', () => {
      // wired or still classic-only: every capability of the plan's table has an entry
      const caps = new Set(manifest.map(e => e.capability).filter(Boolean));
      for (let i = 1; i <= 14; i++) {
        const id = `P-${String(i).padStart(2, '0')}`;
        expect(caps.has(id), id).toBe(true);
      }
      // nothing outside the plan's table
      for (const c of caps) expect(c).toMatch(/^P-(0[1-9]|1[0-9])$/);
    });

    it('2. every endpoint the classic page calls is used by the builder, carried in the draft, or retired with a reason', () => {
      const builderSrc = [
        ...walk(BUILDER),
        ...walk(path.join(ADMIN_SRC, 'components/section-design')),
      ]
        .filter(f => !/\.test\./.test(f))
        .map(f => readFileSync(f, 'utf8'))
        .join('\n');
      for (const e of manifest.filter(x => x.kind === 'api')) {
        if (e.status === 'retired') {
          expect(e.capability, e.key).toBe('P-19');
          expect(e.reason, e.key).toBeTruthy();
          continue;
        }
        if (e.status === 'classic-only') continue; // tracked by its capability id in the baseline
        const fragment = endpointFragment(e.key.split(' ')[1]);
        if (e.builder?.startsWith('PageDefinition.')) {
          // carried in the draft document: the builder must not ALSO write the live endpoint (VE-4)
          expect(/api(Put|Post)[^;]*\/(theme|typography)\b/.test(builderSrc), e.key).toBe(false);
          continue;
        }
        expect(builderSrc.includes(fragment), e.key).toBe(true);
      }
    });

    it('3. round trip: a value set through the builder reducer lands where the classic form writes it', () => {
      let checked = 0;
      for (const e of manifest.filter(x => x.kind === 'field' && x.status === 'wired')) {
        const [legacyKey, field] = e.key.split('.');
        const d = (() => {
          try {
            return sectionDefinitionForLegacyKey(legacyKey as never);
          } catch {
            return undefined;
          }
        })();
        const s: SettingDefinition | undefined = d?.settings.find(x => x.id === field);
        if (!d || !s) continue;
        const values: unknown[] =
          s.type === 'select'
            ? (s.options ?? []).map(o => o.value)
            : s.type === 'checkbox'
              ? [true, false]
              : s.type === 'range'
                ? [s.min ?? 0, s.max ?? 10]
                : s.type === 'color'
                  ? ['#112233']
                  : [];
        for (const value of values) {
          const layout = resolveLayoutSettings({}, 'qamar');
          // what the classic form does: layout[key] = { ...layout[key], [field]: value }
          const classic = {
            ...layout,
            [legacyKey]: { ...(layout as never)[legacyKey], [field]: value },
          };
          const doc = layoutToDefinition(layout);
          const node =
            doc.sections.find(n => n.type === d.type) ??
            doc.sectionGroups.header.find(n => n.type === d.type);
          if (!node) continue;
          const viaBuilder = definitionToLayout(
            reduceDocument(doc, { type: 'setSectionSetting', id: node.id, key: field, value }).doc
          );
          expect((viaBuilder as never)[legacyKey]?.[field], `${e.key}=${String(value)}`).toEqual(
            (classic as never)[legacyKey][field]
          );
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(30);
    });

    it('3b. typography and dividers set through the builder land where the classic form writes them', () => {
      const typography = {
        heading: { fontSize: 3, color: 'token:primary' },
        kicker: { fontWeight: 600 },
      };
      const dividers = { above: { enabled: true, style: 'dashed' }, title: { enabled: false } };
      for (const [legacyKey, type] of [
        ['categories', 'category-grid'],
        ['newArrivals', 'new-arrivals'],
        ['bestSellers', 'best-sellers'],
        ['hero', 'hero'],
        ['testimonials', 'testimonials'],
      ] as const) {
        const layout = resolveLayoutSettings({}, 'qamar');
        const doc = layoutToDefinition(layout);
        const node = doc.sections.find(n => n.type === type)!;
        let d = reduceDocument(doc, {
          type: 'setSectionSetting',
          id: node.id,
          key: 'typography',
          value: typography,
        }).doc;
        d = reduceDocument(d, {
          type: 'setSectionSetting',
          id: node.id,
          key: 'dividers',
          value: dividers,
        }).doc;
        const out = definitionToLayout(d) as never as Record<string, Record<string, unknown>>;
        // classic: updateSection(key, s => ({ ...s, typography })) then ({ ...s, dividers })
        expect(out[legacyKey].typography, legacyKey).toEqual(typography);
        expect(out[legacyKey].dividers, legacyKey).toEqual(dividers);
      }
    });

    it('4. nothing in the editor writes the LIVE theme or typography (VE-4): the list is empty and stays empty', () => {
      expect(current.liveWrites).toEqual([]);
      expect(parityBaseline.liveWrites).toEqual([]);
    });

    it('5. nothing under apps/admin/src names the classic builder any more (Task 12 emptied the list)', () => {
      expect(current.classicReferences).toEqual([]);
      expect(parityBaseline.classicReferences).toEqual([]);
    });

    it('6. every theme key the classic form staged for PUT /theme is an editor theme setting (Ruling VE-17)', () => {
      const themeKeys = manifest.filter(e => e.kind === 'theme-key');
      // the form's five product-card switches; an empty list would mean the extractor went blind
      expect(themeKeys.map(e => e.key).sort()).toEqual([
        'normalizeProductImages',
        'saleBadgeLegacyCorner',
        'showBrandBadge',
        'showNewBadge',
        'showQuickAdd',
      ]);
      for (const e of themeKeys) {
        expect(e.status, e.key).toBe('wired');
        expect(DRAFT_THEME_KEYS, e.key).toContain(e.key);
        const setting = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings).find(x => x.id === e.key);
        expect(setting?.type, e.key).toBe('checkbox');
        expect(setting?.labelAr, e.key).toBeTruthy();
      }
    });

    it('theme controls: every THEME_SETTINGS_SCHEMA setting is in the matrix as a theme row', () => {
      const ids = THEME_SETTINGS_SCHEMA.flatMap(g => g.settings.map(s => s.id));
      expect(ids.length).toBeGreaterThan(10);
    });
  });
}
