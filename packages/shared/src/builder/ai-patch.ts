/**
 * AI patch editing (visual builder Phase 5). The model proposes a STRUCTURED patch, never code:
 * a short list of ops drawn from a closed set, each one a thing the editor's own reducer already
 * does. The patch is Zod-validated here, applied through `reduceDocument` (so every registry
 * invariant still holds), every value is checked against the setting's declared type, and the
 * caller validates the whole resulting document before anything is saved. Nothing in a patch can
 * carry markup, an object, a free key or a foreign id: unknown input is rejected, not coerced.
 *
 * Pure: no I/O, never mutates its input. The merchant sees `changes` (before/after) and applies or
 * rejects; applying goes through the normal draft save, so it is undoable and never publishes.
 */
import { z } from 'zod/v3';
import { reduceDocument, locateSection, type ReduceResult } from './editor/document-reducer';
import { DRAFT_THEME_KEYS, draftThemeSchema } from './theme-draft';
import { SECTION_REGISTRY, getSectionDefinition, sectionAllowedOnPage } from './registry';
import { THEME_SETTINGS_SCHEMA, type SettingDefinition } from './settings-schema';
import type { PageDefinition } from './schema';
import { SECTION_ID_RE } from './schema';
import { isPlaceholderCopy } from './placeholder-copy';

export const AI_PATCH_MAX_OPS = 12;

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const key = z
  .string()
  .regex(KEY_RE)
  .refine(k => !FORBIDDEN_KEYS.has(k));
const id = z.string().regex(SECTION_ID_RE);
/** Scalars only: a patch value is never an object, an array or markup-bearing structure. */
const scalar = z.union([z.string().max(600), z.number().finite(), z.boolean()]);

export const aiPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setSectionSetting'), id, key, value: scalar }).strict(),
  z
    .object({ op: z.literal('setBlockSetting'), sectionId: id, blockId: id, key, value: scalar })
    .strict(),
  z.object({ op: z.literal('setSectionHidden'), id, hidden: z.boolean() }).strict(),
  z.object({ op: z.literal('moveSection'), id, toIndex: z.number().int().min(0).max(60) }).strict(),
  z.object({ op: z.literal('removeSection'), id }).strict(),
  z
    .object({
      op: z.literal('addSection'),
      sectionType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      presetIndex: z.number().int().min(0).max(10),
      index: z.number().int().min(0).max(60).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('addBlock'),
      sectionId: id,
      blockType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    })
    .strict(),
  z
    .object({
      op: z.literal('moveBlock'),
      sectionId: id,
      blockId: id,
      toIndex: z.number().int().min(0).max(40),
    })
    .strict(),
  z.object({ op: z.literal('removeBlock'), sectionId: id, blockId: id }).strict(),
  /**
   * Point a section or block at something that already exists in THIS store: a product list, a category,
   * a product image, an internal page link. The value must be one of the references the service handed the
   * model (`AiPatchAllow`): an id, slug or URL the model made up is rejected, never saved.
   */
  z
    .object({
      op: z.literal('setRef'),
      sectionId: id,
      blockId: id.optional(),
      key,
      kind: z.enum(['image', 'link', 'category', 'products']),
      value: z.union([z.string().max(300), z.array(z.string().max(80)).min(1).max(12)]),
    })
    .strict(),
  /** Phone / tablet fixes: the same setting, overridden for one viewport only. */
  z
    .object({
      op: z.literal('setViewportSetting'),
      id,
      viewport: z.enum(['tablet', 'mobile']),
      key,
      value: scalar,
    })
    .strict(),
  z
    .object({
      op: z.literal('setViewportHidden'),
      id,
      viewport: z.enum(['tablet', 'mobile']),
      hidden: z.boolean(),
    })
    .strict(),
  z
    .object({ op: z.literal('setTheme'), key, value: z.union([z.string().max(100), z.boolean()]) })
    .strict(),
]);
export type AiPatchOp = z.infer<typeof aiPatchOpSchema>;

export const aiPatchSchema = z
  .object({
    /** One plain sentence per language telling the merchant what the patch does. */
    summaryEn: z.string().max(300),
    summaryAr: z.string().max(300),
    ops: z.array(aiPatchOpSchema).max(AI_PATCH_MAX_OPS),
  })
  .strict();
export type AiPatch = z.infer<typeof aiPatchSchema>;

export type AiPatchRejection =
  | 'NOT_FOUND'
  | 'UNKNOWN_SETTING'
  | 'UNKNOWN_THEME_KEY'
  | 'BAD_VALUE'
  /** NEVER-OVERWRITE-1: the merchant's own words (or image, link) are never replaced by the AI. */
  | 'OVERWRITE_PROTECTED'
  /** A product / category / image / link the store does not have (or the model was not shown). */
  | 'NOT_ALLOWED'
  | 'NOT_RESPONSIVE'
  | NonNullable<ReduceResult['rejected']>;

export interface AiPatchChange {
  op: AiPatchOp['op'];
  /** Section (or theme) the change touches. */
  id?: string;
  blockId?: string;
  key?: string;
  before?: unknown;
  after?: unknown;
  /** Human labels from the registry so the diff reads in the merchant's language. */
  labelEn: string;
  labelAr: string;
}

export interface AiPatchResult {
  doc: PageDefinition;
  changes: AiPatchChange[];
  rejected: Array<{ index: number; reason: AiPatchRejection }>;
}

function settingDef(
  defs: readonly SettingDefinition[],
  k: string
): { def: SettingDefinition; ar: boolean } | null {
  for (const d of defs) {
    if (d.id === k) return { def: d, ar: false };
    if (d.localized && `${d.id}Ar` === k) return { def: d, ar: true };
  }
  return null;
}

function themeLabel(key: string): { labelEn: string; labelAr: string } | undefined {
  for (const g of THEME_SETTINGS_SCHEMA)
    for (const s of g.settings) if (String(s.id) === key) return s;
  return undefined;
}

/**
 * What `setRef` may point at: the references of THIS store the model was shown, nothing else.
 * Built by the service from the store's own catalogue; absent = every `setRef` is refused.
 */
export interface AiPatchAllow {
  productIds: ReadonlySet<string>;
  categorySlugs: ReadonlySet<string>;
  imageUrls: ReadonlySet<string>;
  linkPaths: ReadonlySet<string>;
}

/**
 * NEVER-OVERWRITE-1 for page copy: a text, image or link setting is fill-only. The AI may set it when it is
 * empty, placeholder copy (`isPlaceholderCopy`), or still the starter value the section shipped with (the
 * setting default, or the same key in one of the section's presets); anything else is the merchant's own
 * and stays. Choice settings (a select, a range, a colour, a switch) are design, not words: not protected.
 */
function isStarterValue(
  current: unknown,
  def: SettingDefinition,
  presets: ReadonlyArray<{ settings?: Record<string, unknown> }>,
  key: string
): boolean {
  if (current === undefined || current === null || current === '') return true;
  if (typeof current === 'string' && isPlaceholderCopy(current)) return true;
  if (current === def.default) return true;
  // '/products' and '#' are the links a fresh section ships with, not a choice the merchant made.
  if (def.type === 'url' && (current === '/products' || current === '#')) return true;
  return presets.some(p => p.settings?.[key] === current);
}

/** Words the merchant may have written: text and textarea (and their Arabic twins). */
const isWords = (d: SettingDefinition) => d.type === 'text' || d.type === 'textarea';

const HEX = /^#[0-9a-fA-F]{6}$/;
const TOKEN = /^token:[a-zA-Z]+$/;

/** A value is acceptable only if it fits the declared control. */
function valueFits(d: SettingDefinition, v: unknown): boolean {
  switch (d.type) {
    case 'checkbox':
      return typeof v === 'boolean';
    case 'range':
      return (
        typeof v === 'number' &&
        (d.min === undefined || v >= d.min) &&
        (d.max === undefined || v <= d.max)
      );
    case 'select':
      return !!d.options?.some(o => o.value === v);
    case 'color':
      return typeof v === 'string' && (HEX.test(v) || TOKEN.test(v));
    case 'text':
    case 'textarea':
      return typeof v === 'string' && !/[<>]/.test(v);
    // media, links, catalogue refs and compound editors are never set by the model
    default:
      return false;
  }
}

export function applyAiPatch(
  input: PageDefinition,
  ops: readonly AiPatchOp[],
  allow?: AiPatchAllow
): AiPatchResult {
  let doc = input;
  const changes: AiPatchChange[] = [];
  const rejected: AiPatchResult['rejected'] = [];
  const reject = (index: number, reason: AiPatchRejection) => rejected.push({ index, reason });

  ops.forEach((op, index) => {
    switch (op.op) {
      case 'setSectionSetting': {
        const at = locateSection(doc, op.id);
        if (!at) return reject(index, 'NOT_FOUND');
        const sd = getSectionDefinition(at.node.type);
        const hit = sd && settingDef(sd.settings, op.key);
        if (!sd || !hit) return reject(index, 'UNKNOWN_SETTING');
        if (!valueFits(hit.def, op.value)) return reject(index, 'BAD_VALUE');
        if (at.node.settings[op.key] === op.value) return;
        if (
          isWords(hit.def) &&
          !isStarterValue(at.node.settings[op.key], hit.def, sd.presets, op.key)
        )
          return reject(index, 'OVERWRITE_PROTECTED');
        const r = reduceDocument(doc, {
          type: 'setSectionSetting',
          id: op.id,
          key: op.key,
          value: op.value,
        });
        if (r.rejected) return reject(index, r.rejected);
        changes.push({
          op: op.op,
          id: op.id,
          key: op.key,
          before: at.node.settings[op.key],
          after: op.value,
          labelEn: `${sd.labelEn}: ${hit.def.labelEn}`,
          labelAr: `${sd.labelAr}: ${hit.def.labelAr}`,
        });
        doc = r.doc;
        return;
      }
      case 'setBlockSetting': {
        const at = locateSection(doc, op.sectionId);
        const block = at?.node.blocks?.find(b => b.id === op.blockId);
        if (!at || !block) return reject(index, 'NOT_FOUND');
        const bd = getSectionDefinition(at.node.type)?.blocks.find(b => b.type === block.type);
        const hit = bd && settingDef(bd.settings, op.key);
        if (!bd || !hit) return reject(index, 'UNKNOWN_SETTING');
        if (!valueFits(hit.def, op.value)) return reject(index, 'BAD_VALUE');
        if (block.settings[op.key] === op.value) return;
        if (
          isWords(hit.def) &&
          !isStarterValue(
            block.settings[op.key],
            hit.def,
            (getSectionDefinition(at.node.type)?.presets ?? []).flatMap(p =>
              (p.blocks ?? []).filter(b => b.type === block.type)
            ),
            op.key
          )
        )
          return reject(index, 'OVERWRITE_PROTECTED');
        const r = reduceDocument(doc, {
          type: 'setBlockSetting',
          sectionId: op.sectionId,
          blockId: op.blockId,
          key: op.key,
          value: op.value,
        });
        if (r.rejected) return reject(index, r.rejected);
        changes.push({
          op: op.op,
          id: op.sectionId,
          blockId: op.blockId,
          key: op.key,
          before: block.settings[op.key],
          after: op.value,
          labelEn: `${bd.labelEn}: ${hit.def.labelEn}`,
          labelAr: `${bd.labelAr}: ${hit.def.labelAr}`,
        });
        doc = r.doc;
        return;
      }
      case 'setSectionHidden':
      case 'moveSection':
      case 'removeSection':
      case 'addSection': {
        const at = op.op === 'addSection' ? null : locateSection(doc, op.id);
        if (op.op !== 'addSection' && !at) return reject(index, 'NOT_FOUND');
        if (op.op === 'setSectionHidden' && !!at!.node.hidden === op.hidden) return;
        const r =
          op.op === 'addSection'
            ? reduceDocument(doc, {
                type: 'addSection',
                list: getSectionDefinition(op.sectionType)?.group ?? 'template',
                sectionType: op.sectionType,
                presetIndex: op.presetIndex,
                index: op.index,
              })
            : op.op === 'setSectionHidden'
              ? reduceDocument(doc, { type: 'setSectionHidden', id: op.id, hidden: op.hidden })
              : op.op === 'moveSection'
                ? reduceDocument(doc, { type: 'moveSection', id: op.id, toIndex: op.toIndex })
                : reduceDocument(doc, { type: 'removeSection', id: op.id });
        if (r.rejected) return reject(index, r.rejected);
        const sd = getSectionDefinition(
          at?.node.type ?? (op.op === 'addSection' ? op.sectionType : '')
        );
        changes.push({
          op: op.op,
          id: op.op === 'addSection' ? r.createdId : op.id,
          before: op.op === 'setSectionHidden' ? !!at!.node.hidden : undefined,
          after:
            op.op === 'setSectionHidden'
              ? op.hidden
              : op.op === 'moveSection'
                ? op.toIndex
                : undefined,
          labelEn: sd?.labelEn ?? '',
          labelAr: sd?.labelAr ?? '',
        });
        doc = r.doc;
        return;
      }

      case 'addBlock': {
        const at = locateSection(doc, op.sectionId);
        if (!at) return reject(index, 'NOT_FOUND');
        const r = reduceDocument(doc, {
          type: 'addBlock',
          sectionId: op.sectionId,
          blockType: op.blockType,
        });
        if (r.rejected) return reject(index, r.rejected);
        const sd = getSectionDefinition(at.node.type);
        const bd = sd?.blocks.find(b => b.type === op.blockType);
        changes.push({
          op: op.op,
          id: op.sectionId,
          blockId: r.createdId,
          labelEn: `${sd?.labelEn ?? ''}: add ${bd?.labelEn ?? op.blockType}`,
          labelAr: `${sd?.labelAr ?? ''}: إضافة ${bd?.labelAr ?? op.blockType}`,
        });
        doc = r.doc;
        return;
      }
      case 'moveBlock':
      case 'removeBlock': {
        const at = locateSection(doc, op.sectionId);
        const block = at?.node.blocks?.find(b => b.id === op.blockId);
        if (!at || !block) return reject(index, 'NOT_FOUND');
        const r =
          op.op === 'moveBlock'
            ? reduceDocument(doc, {
                type: 'moveBlock',
                sectionId: op.sectionId,
                blockId: op.blockId,
                toIndex: op.toIndex,
              })
            : reduceDocument(doc, {
                type: 'removeBlock',
                sectionId: op.sectionId,
                blockId: op.blockId,
              });
        if (r.rejected) return reject(index, r.rejected);
        const sd = getSectionDefinition(at.node.type);
        const bd = sd?.blocks.find(b => b.type === block.type);
        changes.push({
          op: op.op,
          id: op.sectionId,
          blockId: op.blockId,
          after: op.op === 'moveBlock' ? op.toIndex : undefined,
          labelEn: `${sd?.labelEn ?? ''}: ${op.op === 'moveBlock' ? 'move' : 'remove'} ${bd?.labelEn ?? block.type}`,
          labelAr: `${sd?.labelAr ?? ''}: ${op.op === 'moveBlock' ? 'نقل' : 'حذف'} ${bd?.labelAr ?? block.type}`,
        });
        doc = r.doc;
        return;
      }
      case 'setRef': {
        const at = locateSection(doc, op.sectionId);
        if (!at) return reject(index, 'NOT_FOUND');
        const sd = getSectionDefinition(at.node.type);
        const block = op.blockId ? at.node.blocks?.find(b => b.id === op.blockId) : undefined;
        if (op.blockId && !block) return reject(index, 'NOT_FOUND');
        const owner = block ? sd?.blocks.find(b => b.type === block.type) : sd;
        const hit = owner && settingDef(owner.settings, op.key);
        if (!owner || !hit) return reject(index, 'UNKNOWN_SETTING');
        const wantType = {
          image: 'image',
          link: 'url',
          category: 'category',
          products: 'product_list',
        }[op.kind];
        if (hit.def.type !== wantType) return reject(index, 'BAD_VALUE');
        // The value must be one of THIS store's references the model was shown.
        const values = Array.isArray(op.value) ? op.value : [op.value];
        if ((op.kind === 'products') !== Array.isArray(op.value)) return reject(index, 'BAD_VALUE');
        const set =
          op.kind === 'image'
            ? allow?.imageUrls
            : op.kind === 'link'
              ? allow?.linkPaths
              : op.kind === 'category'
                ? allow?.categorySlugs
                : allow?.productIds;
        if (!set || values.some(v => !set.has(v))) return reject(index, 'NOT_ALLOWED');
        if (op.kind === 'products' && hit.def.max !== undefined && values.length > hit.def.max)
          return reject(index, 'BAD_VALUE');
        const settings = (block ?? at.node).settings;
        const current = settings[op.key];
        if (JSON.stringify(current) === JSON.stringify(op.value)) return;
        // Fill-only: a picture or link the merchant chose stays; a category or product list is a pick, shown
        // as a before/after the merchant approves.
        if (
          (op.kind === 'image' || op.kind === 'link') &&
          !isStarterValue(
            current,
            hit.def,
            block
              ? (sd?.presets ?? []).flatMap(p =>
                  (p.blocks ?? []).filter(b => b.type === block.type)
                )
              : (sd?.presets ?? []),
            op.key
          )
        )
          return reject(index, 'OVERWRITE_PROTECTED');
        const r = block
          ? reduceDocument(doc, {
              type: 'setBlockSetting',
              sectionId: op.sectionId,
              blockId: block.id,
              key: op.key,
              value: op.value,
            })
          : reduceDocument(doc, {
              type: 'setSectionSetting',
              id: op.sectionId,
              key: op.key,
              value: op.value,
            });
        if (r.rejected) return reject(index, r.rejected);
        changes.push({
          op: op.op,
          id: op.sectionId,
          blockId: op.blockId,
          key: op.key,
          before: current,
          after: op.value,
          labelEn: `${owner.labelEn}: ${hit.def.labelEn}`,
          labelAr: `${owner.labelAr}: ${hit.def.labelAr}`,
        });
        doc = r.doc;
        return;
      }
      case 'setViewportSetting':
      case 'setViewportHidden': {
        const at = locateSection(doc, op.id);
        if (!at) return reject(index, 'NOT_FOUND');
        const sd = getSectionDefinition(at.node.type);
        if (!sd) return reject(index, 'NOT_FOUND');
        if (op.op === 'setViewportHidden') {
          if (!sd.responsive.hidden.includes(op.viewport)) return reject(index, 'NOT_RESPONSIVE');
          const before = at.node.responsive?.[op.viewport]?.hidden;
          if (before === op.hidden) return;
          const r = reduceDocument(doc, {
            type: 'setViewportHidden',
            id: op.id,
            viewport: op.viewport,
            hidden: op.hidden,
          });
          if (r.rejected) return reject(index, r.rejected);
          changes.push({
            op: op.op,
            id: op.id,
            before,
            after: op.hidden,
            labelEn: `${sd.labelEn}: hide on ${op.viewport}`,
            labelAr: `${sd.labelAr}: إخفاء على ${op.viewport === 'mobile' ? 'الموبايل' : 'التابلت'}`,
          });
          doc = r.doc;
          return;
        }
        const hit = settingDef(sd.settings, op.key);
        if (!hit) return reject(index, 'UNKNOWN_SETTING');
        if (!sd.responsive.settings[op.viewport]?.includes(hit.def.id))
          return reject(index, 'NOT_RESPONSIVE');
        if (!valueFits(hit.def, op.value)) return reject(index, 'BAD_VALUE');
        // A viewport override of a words setting is still the merchant's words: same fill-only rule.
        if (isWords(hit.def)) return reject(index, 'OVERWRITE_PROTECTED');
        const before = at.node.responsive?.[op.viewport]?.settings?.[op.key];
        if (before === op.value) return;
        const r = reduceDocument(doc, {
          type: 'setViewportSetting',
          id: op.id,
          viewport: op.viewport,
          key: op.key,
          value: op.value,
        });
        if (r.rejected) return reject(index, r.rejected);
        changes.push({
          op: op.op,
          id: op.id,
          key: op.key,
          before,
          after: op.value,
          labelEn: `${sd.labelEn}: ${hit.def.labelEn} (${op.viewport})`,
          labelAr: `${sd.labelAr}: ${hit.def.labelAr} (${op.viewport === 'mobile' ? 'موبايل' : 'تابلت'})`,
        });
        doc = r.doc;
        return;
      }
      case 'setTheme': {
        if (!DRAFT_THEME_KEYS.includes(op.key)) return reject(index, 'UNKNOWN_THEME_KEY');
        if (doc.theme?.[op.key] === op.value) return;
        const next = { ...(doc.theme ?? {}), [op.key]: op.value };
        if (!draftThemeSchema.safeParse(next).success) return reject(index, 'BAD_VALUE');
        changes.push({
          op: op.op,
          key: op.key,
          before: doc.theme?.[op.key],
          after: op.value,
          labelEn: `Theme: ${themeLabel(op.key)?.labelEn ?? op.key}`,
          labelAr: `المظهر: ${themeLabel(op.key)?.labelAr ?? op.key}`,
        });
        doc = { ...doc, theme: next };
        return;
      }
    }
  });
  return { doc, changes, rejected };
}

/**
 * What the model is allowed to see and touch: section ids/types with the setting keys each declares
 * and their CURRENT scalar values, the section types that can be added, and the editable theme keys.
 * The document holds no buyer data (catalogue references are ids, never customer rows), and long
 * strings are truncated so a merchant's own copy cannot flood the prompt.
 */
export function describeAiPatchContext(doc: PageDefinition) {
  const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : v);
  const nodes = [...doc.sectionGroups.header, ...doc.sections, ...doc.sectionGroups.footer];
  return {
    pageKey: doc.pageKey,
    sections: nodes.map(n => {
      const sd = getSectionDefinition(n.type);
      const keys = (sd?.settings ?? []).flatMap(s => (s.localized ? [s.id, `${s.id}Ar`] : [s.id]));
      const current: Record<string, unknown> = {};
      for (const k of keys) {
        const v = n.settings[k];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          current[k] = clip(v);
      }
      return {
        id: n.id,
        type: n.type,
        hidden: !!n.hidden,
        settingKeys: keys,
        current,
        blocks: (n.blocks ?? []).map(b => ({ id: b.id, type: b.type })),
      };
    }),
    addableTypes: SECTION_REGISTRY.filter(d => sectionAllowedOnPage(d, doc.pageKey)).map(d => ({
      type: d.type,
      presets: d.presets.length,
    })),
    themeKeys: [...DRAFT_THEME_KEYS],
    theme: Object.fromEntries(
      Object.entries(doc.theme ?? {}).filter(
        ([, v]) => typeof v === 'string' || typeof v === 'boolean'
      )
    ),
  };
}
