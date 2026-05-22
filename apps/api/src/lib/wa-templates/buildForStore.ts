/**
 * Per-store template builder — Phase 7 smart generation.
 *
 * Takes the canonical TEMPLATES library from definitions.ts and rewrites
 * each entry for a specific store: the template `name` is prefixed with
 * the store slug (so two stores submitting to two different WABAs end up
 * with distinguishable template names in Meta Business Manager), and
 * the `example.body_text` uses the store's actual name + nameAr in
 * the placeholder positions that bind to {{4}} = storeName.
 *
 * Template body text itself is unchanged — variables are positional
 * placeholders ({{1}}, {{2}}, ...) so the merchant's runtime data
 * (customer name, order number, etc.) still gets passed at send time.
 *
 * Meta's template-name rules: lowercase letters, digits, underscores
 * only; max 512 chars. We hyphen→underscore the store.slug and
 * concatenate with the existing v1 purpose name.
 *
 * For v1 we do NOT attach a HEADER image — uploading a logo to Meta
 * requires the resumable-media protocol which is a separate integration.
 * If Ahmad wants logo headers on marketing templates (welcomeBack,
 * cartAbandoned), v2 lifts those via Meta's POST /<APP_ID>/uploads
 * flow and stashes the media handle on the template before submit.
 */

import { TEMPLATES, type TemplateDefinition } from './definitions';

export interface StoreBrandingForTemplates {
  slug: string;
  name: string;
  nameAr: string | null;
}

/**
 * Slugify a store.slug into a Meta-compatible template name prefix.
 * store.slug is already lowercase + hyphens (URL-safe); we only need
 * hyphens→underscores. Defensive: strip anything non [a-z0-9_].
 */
export function slugToTemplatePrefix(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
}

/**
 * Build the 12-template definition list for a specific store.
 * Each template's `name` becomes `<prefix>_<purpose>_v1` and example
 * body_text strings substitute the store's name in the position that
 * matches the {{N}} = store-name placeholder.
 */
export function buildTemplatesForStore(store: StoreBrandingForTemplates): TemplateDefinition[] {
  const prefix = slugToTemplatePrefix(store.slug);
  const enName = store.name;
  // Fall back to the english name if the merchant hasn't set nameAr.
  // Better example than leaving Force-AI default brand strings in the AR.
  const arName = store.nameAr || store.name;

  return TEMPLATES.map(tmpl => {
    // Replace 'force_' prefix with `<store-slug>_` for the Meta-side name.
    // Keep the rest of the canonical name (purpose + version) untouched.
    const newName = tmpl.name.replace(/^force_/, `${prefix}_`);

    // Rewrite each example body_text array to substitute the store name.
    // Position depends on the template: every template's variableLabels
    // includes 'Store name' (or arabic equivalent) at a known position.
    // We identify the store-name slot dynamically by matching the label
    // English-name keyword so the substitution stays correct even if the
    // variable count grows in v2.
    const isStoreNameLabel = (label: string) =>
      /store name/i.test(label) || /اسم المتجر/.test(label);
    const storeNameIdx = tmpl.variableLabels.findIndex(isStoreNameLabel);
    const localizedName = tmpl.language === 'ar' ? arName : enName;

    const rewrittenComponents = tmpl.components.map(c => {
      if (c.type !== 'BODY' || !c.example?.body_text) return c;
      const bodyText = c.example.body_text.map(row =>
        row.map((val, i) => (i === storeNameIdx ? localizedName : val))
      );
      return { ...c, example: { ...c.example, body_text: bodyText } };
    });

    return {
      ...tmpl,
      name: newName,
      components: rewrittenComponents,
    };
  });
}
