/**
 * Full validation of a `PageDefinition` (visual builder Phase 1).
 *
 * `pageDefinitionSchema` checks the envelope; this adds what a structural
 * schema cannot: registry types, per-type props (the SAME Zod schema the
 * legacy layout PUT uses, applied to the reconstructed legacy object),
 * cardinality, unique ids, responsive capabilities, size limits, URL schemes
 * and RTL-safe (logical) alignment. Errors carry a JSON-pointer `path` and an
 * en/ar message so an editor can point at the field.
 *
 * Unknown section types are an ERROR on write (draft save / publish) and a
 * WARNING on read: `renderableSections` skips them so a public render never
 * throws on a document written by a newer editor.
 */
import type { z } from 'zod';
import { isSafeUrl } from '../utils/safe-url';
import { storeLayoutSchema } from './layout-schema';
import { allSections, sectionToLegacy } from './adapter';
import { isPlaceholderCopy } from './placeholder-copy';
import { getSectionDefinition, VIEWPORTS } from './registry';
import { getLook } from '../looks/registry';
import {
  BUILDER_LIMITS,
  pageDefinitionSchema,
  type PageDefinition,
  type SectionNode,
} from './schema';
import type { SectionGroup } from './registry';
import type { SettingDefinition } from './settings-schema';

export interface BuilderIssue {
  code:
    | 'SCHEMA'
    | 'UNKNOWN_TYPE'
    | 'DUPLICATE_ID'
    | 'CARDINALITY'
    | 'TOO_MANY_SECTIONS'
    | 'DOC_TOO_LARGE'
    | 'STRING_TOO_LONG'
    | 'UNSAFE_URL'
    | 'PHYSICAL_ALIGNMENT'
    | 'RESPONSIVE_NOT_SUPPORTED'
    | 'BLOCK_NOT_SUPPORTED'
    | 'GROUP_MISMATCH'
    | 'PROPS_INVALID'
    | 'REF_NOT_FOUND'
    | 'MISSING_IMAGE'
    | 'PLACEHOLDER_COPY';
  path: string;
  messageEn: string;
  messageAr: string;
}

export interface ValidateOptions {
  /**
   * Resolves the catalogue references a document holds (category slugs,
   * product ids) against the CALLER's store. Under strict RLS another
   * store's rows are invisible, so "not found" covers both a deleted row and
   * a foreign one. Reported as WARNINGS (Ruling BUILDER-REFS-1): storefront
   * product fetches are store-scoped, so a foreign id can never render.
   */
  resolveRefs?: (refs: {
    categorySlugs: string[];
    productIds: string[];
  }) => Promise<{ categorySlugs: Set<string>; productIds: Set<string> }>;
}

export interface ValidationResult {
  ok: boolean;
  definition?: PageDefinition;
  errors: BuilderIssue[];
  warnings: BuilderIssue[];
}

const IMAGE_KEY_RE = /^(image|imageAr|imageMobile|imageMobileAr)$/;
const VIDEO_KEY_RE = /^(video|videoMobile)$/;
const URL_KEY_RE = /^(link|ctaHref|href|buttonLink)$/;
const ALIGN_KEY_RE = /align$/i;

function issue(
  code: BuilderIssue['code'],
  path: string,
  messageEn: string,
  messageAr: string
): BuilderIssue {
  return { code, path, messageEn, messageAr };
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Walk props: string size, URL schemes, logical alignment. */
function scanValue(value: unknown, path: string, key: string, errors: BuilderIssue[]): void {
  if (typeof value === 'string') {
    if (byteLength(value) > BUILDER_LIMITS.maxStringBytes)
      errors.push(
        issue('STRING_TOO_LONG', path, 'Text is longer than 2 KB.', 'النص أطول من 2 كيلوبايت.')
      );
    if (
      (IMAGE_KEY_RE.test(key) || VIDEO_KEY_RE.test(key) || URL_KEY_RE.test(key)) &&
      value !== ''
    ) {
      const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
      const imageOk = !IMAGE_KEY_RE.test(key) || !scheme || scheme === 'https' || scheme === 'http';
      const videoOk = !VIDEO_KEY_RE.test(key) || !scheme || scheme === 'https';
      if (!isSafeUrl(value) || !imageOk || !videoOk)
        errors.push(
          issue(
            'UNSAFE_URL',
            path,
            'Links must be a relative path or http(s)/mailto/tel; images must be http(s) or relative.',
            'يجب أن يكون الرابط مساراً نسبياً أو http(s)/mailto/tel، والصور http(s) أو مساراً نسبياً.'
          )
        );
    }
    if (ALIGN_KEY_RE.test(key) && /^(left|right)$/i.test(value))
      errors.push(
        issue(
          'PHYSICAL_ALIGNMENT',
          path,
          'Use start / center / end so the layout mirrors in Arabic.',
          'استخدم البداية / الوسط / النهاية حتى ينعكس التصميم في العربية.'
        )
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, `${path}/${i}`, key, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanValue(v, `${path}/${k}`, k, errors);
  }
}

function zodIssues(err: z.ZodError, base: string): BuilderIssue[] {
  return err.issues.map(i =>
    issue('PROPS_INVALID', `${base}/${i.path.join('/')}`, i.message, 'قيمة غير صالحة لهذا الحقل.')
  );
}

function validateSection(
  node: SectionNode,
  path: string,
  group: SectionGroup,
  errors: BuilderIssue[]
): void {
  const d = getSectionDefinition(node.type);
  if (!d) {
    errors.push(
      issue(
        'UNKNOWN_TYPE',
        `${path}/type`,
        `Unknown section type "${node.type}".`,
        `نوع قسم غير معروف "${node.type}".`
      )
    );
    return;
  }
  if (d.group !== group)
    errors.push(
      issue(
        'GROUP_MISMATCH',
        path,
        `"${d.labelEn}" belongs in the ${d.group} group.`,
        `مكان "${d.labelAr}" هو مجموعة ${d.group}.`
      )
    );
  const blockIds = new Set<string>();
  const blockCounts = new Map<string, number>();
  (node.blocks ?? []).forEach((b, j) => {
    const bd = d.blocks.find(x => x.type === b.type);
    if (!bd) {
      errors.push(
        issue(
          'BLOCK_NOT_SUPPORTED',
          `${path}/blocks/${j}/type`,
          `"${d.labelEn}" does not accept "${b.type}" blocks.`,
          `لا يقبل "${d.labelAr}" عناصر من نوع "${b.type}".`
        )
      );
      return;
    }
    if (blockIds.has(b.id))
      errors.push(
        issue(
          'DUPLICATE_ID',
          `${path}/blocks/${j}/id`,
          `Duplicate block id "${b.id}".`,
          `معرّف عنصر مكرر "${b.id}".`
        )
      );
    blockIds.add(b.id);
    if (bd.propsSchema) {
      const parsedBlock = bd.propsSchema.safeParse(b.settings);
      if (!parsedBlock.success)
        errors.push(...zodIssues(parsedBlock.error, `${path}/blocks/${j}/settings`));
    }
    blockCounts.set(b.type, (blockCounts.get(b.type) ?? 0) + 1);
  });
  for (const bd of d.blocks)
    if ((blockCounts.get(bd.type) ?? 0) > bd.maxCount)
      errors.push(
        issue(
          'CARDINALITY',
          `${path}/blocks`,
          `At most ${bd.maxCount} "${bd.labelEn}" blocks.`,
          `الحد الأقصى ${bd.maxCount} من "${bd.labelAr}".`
        )
      );
  for (const v of VIEWPORTS) {
    const o = node.responsive?.[v];
    if (!o) continue;
    if (o.hidden !== undefined && !d.responsive.hidden.includes(v))
      errors.push(
        issue(
          'RESPONSIVE_NOT_SUPPORTED',
          `${path}/responsive/${v}/hidden`,
          'Not supported.',
          'غير مدعوم.'
        )
      );
    for (const key of Object.keys(o.settings ?? {})) {
      if (!(d.responsive.settings[v] ?? []).includes(key))
        errors.push(
          issue(
            'RESPONSIVE_NOT_SUPPORTED',
            `${path}/responsive/${v}/settings/${key}`,
            `"${key}" cannot be set per ${v} for this section.`,
            `لا يمكن ضبط "${key}" لكل جهاز في هذا القسم.`
          )
        );
    }
  }
  scanValue(node.settings, `${path}/settings`, '', errors);
  (node.blocks ?? []).forEach((b, j) =>
    scanValue(b.settings, `${path}/blocks/${j}/settings`, '', errors)
  );
  if (node.responsive) scanValue(node.responsive, `${path}/responsive`, '', errors);
  const parsed = d.propsSchema.safeParse(sectionToLegacy(node, d.legacyKey ?? ''));
  if (!parsed.success) errors.push(...zodIssues(parsed.error, `${path}/settings`));
}

/** Synchronous checks (no catalogue lookups). */
export function validateDefinitionSync(input: unknown): ValidationResult {
  const errors: BuilderIssue[] = [];
  const warnings: BuilderIssue[] = [];
  const env = pageDefinitionSchema.safeParse(input);
  if (!env.success) {
    return {
      ok: false,
      errors: env.error.issues.map(i =>
        issue('SCHEMA', `/${i.path.join('/')}`, i.message, 'بنية المستند غير صالحة.')
      ),
      warnings,
    };
  }
  const def = env.data;
  const bytes = byteLength(JSON.stringify(def));
  if (bytes > BUILDER_LIMITS.maxDocBytes)
    errors.push(
      issue(
        'DOC_TOO_LARGE',
        '',
        'The page is larger than 256 KB.',
        'حجم الصفحة أكبر من 256 كيلوبايت.'
      )
    );

  const ids = new Set<string>();
  /** Per type: untagged count, and per look tag the count of sections tagged with it. */
  const counts = new Map<string, { untagged: number; tagged: Map<string, number> }>();
  const visit = (nodes: SectionNode[], base: string, group: SectionGroup) => {
    nodes.forEach((n, i) => {
      const path = `${base}/${i}`;
      if (ids.has(n.id))
        errors.push(
          issue(
            'DUPLICATE_ID',
            `${path}/id`,
            `Duplicate section id "${n.id}".`,
            `معرّف قسم مكرر "${n.id}".`
          )
        );
      ids.add(n.id);
      const c = counts.get(n.type) ?? { untagged: 0, tagged: new Map<string, number>() };
      if (n.lookTag === undefined) c.untagged++;
      else c.tagged.set(n.lookTag, (c.tagged.get(n.lookTag) ?? 0) + 1);
      counts.set(n.type, c);
      if (n.lookTag !== undefined && !getLook(n.lookTag))
        errors.push(
          issue(
            'SCHEMA',
            `${path}/lookTag`,
            `Unknown look "${n.lookTag}".`,
            `مظهر غير معروف "${n.lookTag}".`
          )
        );
      validateSection(n, path, group, errors);
    });
  };
  visit(def.sectionGroups.header, '/sectionGroups/header', 'header');
  visit(def.sections, '/sections', 'template');
  visit(def.sectionGroups.footer, '/sectionGroups/footer', 'footer');
  // What renders under any one look is the untagged sections plus that look's tagged ones
  // (`documentForLook`), so the cap applies to that sum, never to tagged sections of other looks.
  for (const [type, c] of counts) {
    const d = getSectionDefinition(type);
    const n = c.untagged + Math.max(0, ...c.tagged.values());
    if (d && n > d.maxCount)
      errors.push(
        issue(
          'CARDINALITY',
          '/sections',
          `At most ${d.maxCount} "${d.labelEn}" section(s).`,
          `الحد الأقصى ${d.maxCount} من قسم "${d.labelAr}".`
        )
      );
  }

  // siteSettings: the non-section layout keys, same schema as the layout PUT.
  const site = storeLayoutSchema.partial().safeParse(def.siteSettings);
  if (!site.success) errors.push(...zodIssues(site.error, '/siteSettings'));
  const shape = storeLayoutSchema.shape as Record<string, unknown>;
  for (const k of Object.keys(def.siteSettings))
    if (!(k in shape))
      errors.push(
        issue('SCHEMA', `/siteSettings/${k}`, `Unknown setting "${k}".`, `إعداد غير معروف "${k}".`)
      );
  scanValue(def.siteSettings, '/siteSettings', '', errors);

  return { ok: errors.length === 0, definition: def, errors, warnings };
}

/**
 * Publish-only readiness checks beyond structural validity. Some things are
 * fine to leave incomplete in a DRAFT (a hero slide added but not yet given
 * an image — `heroSlideSchema.image` is optional precisely so autosave can
 * persist that in-progress state) but must never reach the live storefront.
 * Kept separate from `validateDefinition`/`validateDefinitionSync` so
 * autosave never blocks on an edit still in progress; callers run this
 * ADDITIONALLY, only at publish time.
 */
export function validatePublishReadiness(
  def: PageDefinition,
  opts: { placeholderCopy?: boolean } = {}
): BuilderIssue[] {
  const checkCopy = opts.placeholderCopy !== false;
  const errors: BuilderIssue[] = [];
  const visit = (nodes: SectionNode[], base: string) => {
    nodes.forEach((n, i) => {
      if (n.hidden) return;
      const sectionDef = getSectionDefinition(n.type);
      if (checkCopy && sectionDef) {
        scanPlaceholderCopy(
          n.settings,
          sectionDef.settings,
          `${base}/${i}/settings`,
          sectionDef.labelEn,
          sectionDef.labelAr,
          errors
        );
        (n.blocks ?? []).forEach((b, j) => {
          if (b.hidden) return;
          const blockDef = sectionDef.blocks.find(x => x.type === b.type);
          if (!blockDef) return;
          scanPlaceholderCopy(
            b.settings,
            blockDef.settings,
            `${base}/${i}/blocks/${j}/settings`,
            `${sectionDef.labelEn} / ${blockDef.labelEn}`,
            `${sectionDef.labelAr} / ${blockDef.labelAr}`,
            errors
          );
        });
      }
      if (n.type !== 'hero') return;
      (n.blocks ?? []).forEach((b, j) => {
        if (b.hidden || b.type !== 'slide') return;
        const image = (b.settings as Record<string, unknown>).image;
        if (typeof image !== 'string' || image.trim() === '') {
          errors.push(
            issue(
              'MISSING_IMAGE',
              `${base}/${i}/blocks/${j}/settings/image`,
              'Add an image to this hero slide before publishing.',
              'أضف صورة لهذه الشريحة قبل النشر.'
            )
          );
        }
      });
    });
  };
  visit(def.sectionGroups.header, '/sectionGroups/header');
  visit(def.sections, '/sections');
  visit(def.sectionGroups.footer, '/sectionGroups/footer');
  return errors;
}

/**
 * Flags text/textarea settings (and their `Ar` twins) that still hold
 * placeholder copy. Only descriptor-declared TEXT settings are read, so ids,
 * URLs, colours and select values can never false-positive.
 */
function scanPlaceholderCopy(
  values: Record<string, unknown>,
  descriptors: readonly SettingDefinition[],
  basePath: string,
  sectionEn: string,
  sectionAr: string,
  errors: BuilderIssue[]
): void {
  for (const d of descriptors) {
    if (d.type !== 'text' && d.type !== 'textarea') continue;
    const keys = d.localized ? [d.id, `${d.id}Ar`] : [d.id];
    for (const key of keys) {
      if (!isPlaceholderCopy(values[key])) continue;
      errors.push(
        issue(
          'PLACEHOLDER_COPY',
          `${basePath}/${key}`,
          `"${sectionEn}": "${d.labelEn}" still has placeholder text. Replace it with your own before publishing.`,
          `"${sectionAr}": "${d.labelAr}" لسه فيه نص مؤقت. اكتب نصك قبل النشر.`
        )
      );
    }
  }
}

/** Section types whose settings hold catalogue refs (`categorySlug` / `manualProductIds`). */
const REF_SECTION_TYPES = new Set(['product-carousel', 'featured-collection', 'product-spotlight']);

/** Block types whose settings hold product refs (`productIds`): shop-the-look looks (C11). */
const REF_BLOCK_SECTION_TYPES = new Set(['shop-the-look']);

/** The product ids a shop-the-look `look` block names, as stored. */
function blockProductIds(settings: Record<string, unknown>): unknown[] {
  return Array.isArray(settings.productIds) ? settings.productIds : [];
}

/** Collect catalogue refs held by product sections, collection tiles and shop-the-look looks. */
export function collectRefs(def: PageDefinition): {
  categorySlugs: string[];
  productIds: string[];
} {
  const categorySlugs = new Set<string>();
  const productIds = new Set<string>();
  for (const n of def.sections) {
    if (n.type === 'collection-list')
      for (const b of n.blocks ?? [])
        if (typeof b.settings.categorySlug === 'string' && b.settings.categorySlug)
          categorySlugs.add(b.settings.categorySlug);
    if (REF_BLOCK_SECTION_TYPES.has(n.type))
      for (const b of n.blocks ?? [])
        for (const id of blockProductIds(b.settings))
          if (typeof id === 'string') productIds.add(id);
    if (!REF_SECTION_TYPES.has(n.type)) continue;
    if (typeof n.settings.categorySlug === 'string' && n.settings.categorySlug)
      categorySlugs.add(n.settings.categorySlug);
    if (Array.isArray(n.settings.manualProductIds))
      for (const id of n.settings.manualProductIds) if (typeof id === 'string') productIds.add(id);
  }
  return { categorySlugs: [...categorySlugs], productIds: [...productIds] };
}

export async function validateDefinition(
  input: unknown,
  opts: ValidateOptions = {}
): Promise<ValidationResult> {
  const res = validateDefinitionSync(input);
  if (!res.definition || !opts.resolveRefs) return res;
  const refs = collectRefs(res.definition);
  if (refs.categorySlugs.length === 0 && refs.productIds.length === 0) return res;
  const found = await opts.resolveRefs(refs);
  res.definition.sections.forEach((n, i) => {
    if (n.type === 'collection-list')
      (n.blocks ?? []).forEach((b, j) => {
        const s = b.settings.categorySlug;
        if (typeof s === 'string' && s && !found.categorySlugs.has(s))
          res.warnings.push(
            issue(
              'REF_NOT_FOUND',
              `/sections/${i}/blocks/${j}/settings/categorySlug`,
              `Category "${s}" is not in this store; the tile links to all products.`,
              `الفئة "${s}" غير موجودة في هذا المتجر؛ ستفتح البطاقة كل المنتجات.`
            )
          );
      });
    if (REF_BLOCK_SECTION_TYPES.has(n.type))
      (n.blocks ?? []).forEach((b, j) =>
        blockProductIds(b.settings).forEach((id, k) => {
          if (typeof id === 'string' && !found.productIds.has(id))
            res.warnings.push(
              issue(
                'REF_NOT_FOUND',
                `/sections/${i}/blocks/${j}/settings/productIds/${k}`,
                `Product "${id}" is not in this store and will not show in the look.`,
                `المنتج "${id}" غير موجود في هذا المتجر ولن يظهر في اللوك.`
              )
            );
        })
      );
    if (!REF_SECTION_TYPES.has(n.type)) return;
    const slug = n.settings.categorySlug;
    if (typeof slug === 'string' && slug && !found.categorySlugs.has(slug))
      res.warnings.push(
        issue(
          'REF_NOT_FOUND',
          `/sections/${i}/settings/categorySlug`,
          `Category "${slug}" is not in this store; the carousel falls back to newest products.`,
          `الفئة "${slug}" غير موجودة في هذا المتجر؛ سيعرض الشريط أحدث المنتجات.`
        )
      );
    const ids = Array.isArray(n.settings.manualProductIds) ? n.settings.manualProductIds : [];
    ids.forEach((id, j) => {
      if (typeof id === 'string' && !found.productIds.has(id))
        res.warnings.push(
          issue(
            'REF_NOT_FOUND',
            `/sections/${i}/settings/manualProductIds/${j}`,
            `Product "${id}" is not in this store and will not show.`,
            `المنتج "${id}" غير موجود في هذا المتجر ولن يظهر.`
          )
        );
    });
  });
  return res;
}

/**
 * Read-side tolerance: the sections a renderer should draw, skipping unknown
 * types (a document written by a newer editor) instead of throwing.
 */
export function renderableSections(def: PageDefinition): {
  /** Known sections, in render order (header group, template, footer group). */
  sections: SectionNode[];
  skipped: Array<{ id: string; type: string }>;
} {
  const sections: SectionNode[] = [];
  const skipped: Array<{ id: string; type: string }> = [];
  for (const n of allSections(def)) {
    if (getSectionDefinition(n.type)) sections.push(n);
    else skipped.push({ id: n.id, type: n.type });
  }
  return { sections, skipped };
}
