/**
 * Draft header / footer content edits for the visual builder.
 *
 * The storefront's header menu, the footer link columns and the utility bar are
 * NOT part of `layout_settings`: the classic builder saves them straight into
 * `stores.settings` (`navMenu`, `footerLinks`, `utilityBar`) through
 * `PUT /stores/:id`, which is live at once. The visual editor must not do that,
 * so (same shape of fix as THEME-DRAFT-1) its edits travel in the page document
 * as `PageDefinition.chrome` — a PATCH of exactly those three keys, in the SAME
 * shapes the classic builder writes — and follow the draft / publish / rollback
 * lifecycle:
 *
 *   draft save -> stored in the draft revision only (nothing public changes)
 *   publish    -> merged over `stores.settings` in the SAME `stores` update as
 *                 the `layout_settings` back-write (one statement), then the
 *                 existing post-commit purge covers every cache layer
 *   rollback   -> re-applies the target revision's patch (a revision without
 *                 `chrome` leaves the live settings alone)
 *
 * Every link goes through `isSafeUrl` (relative paths or http/https/mailto/tel;
 * `javascript:`, `data:` and friends are rejected) at the schema, so an unsafe
 * href can never be saved to a draft, let alone published.
 *
 * A draft may hold half-typed rows (blank label or blank link) so autosave can
 * persist them; publish drops blank rows, exactly like the classic editor's save.
 */
import { z } from 'zod/v3';
import { isSafeUrl } from '../utils/safe-url';

/** A blank link is allowed in a draft (a row being typed); anything else must be safe. */
const hrefSchema = z
  .string()
  .max(500)
  .refine(v => v === '' || isSafeUrl(v), {
    message: 'Link must be a relative path or use http(s)/mailto/tel; javascript: is not allowed',
  });
const textSchema = z.string().max(80);

/**
 * A draft logo: an http(s) or site-relative image URL (blank = unchanged). mailto:/tel: pass
 * `isSafeUrl` but are not images, so they are refused here. The API additionally requires the
 * file to live on our media origin before a draft is saved (a logo is fetched server-side).
 */
const logoUrlSchema = z
  .string()
  .max(500)
  .refine(v => v === '' || (isSafeUrl(v) && !/^(mailto|tel):/i.test(v.trim())), {
    message: 'Logo must be an image URL (relative path or http/https); javascript: is not allowed',
  });

export const MAX_NAV_ITEMS = 12;
export const MAX_FOOTER_LINKS_PER_COLUMN = 12;
export const MAX_UTILITY_LINKS = 8;

const navItemSchema = z
  .object({ label: textSchema, labelAr: textSchema.optional(), href: hrefSchema })
  .strict();

const footerLinkSchema = z
  .object({
    name: textSchema,
    nameAr: textSchema.optional(),
    href: hrefSchema,
    enabled: z.boolean().optional(),
  })
  .strict();

const utilityLinkSchema = z
  .object({
    label: textSchema,
    labelAr: textSchema.optional(),
    href: hrefSchema,
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * The footer legal row's settings (`settings.footerLinks.bottomBar`, S-01): the
 * bar switch, the per-link toggles and the © override. Every route that writes
 * settings validates it (store.routes `addSettingsIssues`), and the builder's
 * chrome patch carries it. Unknown legacy keys from rows written before the
 * 2026-05-21 removal are tolerated (ignored by the storefront).
 */
export const COPYRIGHT_OVERRIDE_MAX = 200;
export const footerBottomBarSchema = z.object({
  enabled: z.boolean().optional(),
  copyrightOverride: z.string().max(COPYRIGHT_OVERRIDE_MAX).optional(),
  copyrightOverrideAr: z.string().max(COPYRIGHT_OVERRIDE_MAX).optional(),
  privacyEnabled: z.boolean().optional(),
  termsEnabled: z.boolean().optional(),
  shippingEnabled: z.boolean().optional(),
  returnsEnabled: z.boolean().optional(),
});
/**
 * Tolerant read of a STORED bottomBar before it is validated (FU46 M-7). A row saved before the
 * 2026-05-21 removal can hold `copyrightOverride: null` or an over-long string, and every
 * settings PUT re-validates the whole blob, so the strict schema answered 400 on a field the
 * merchant never touched. null reads as unset and a long value is clamped (the admin input is
 * capped at 200 and the storefront clamps on read too). Any other shape is returned untouched
 * for the schema to judge.
 */
export function normalizeStoredBottomBar(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of ['copyrightOverride', 'copyrightOverrideAr']) {
    const v = out[key];
    if (v === null) delete out[key];
    else if (typeof v === 'string') out[key] = v.slice(0, COPYRIGHT_OVERRIDE_MAX);
  }
  return out;
}
export type FooterBottomBarSettings = z.infer<typeof footerBottomBarSchema>;

export const draftChromeSchema = z
  .object({
    logo: logoUrlSchema.optional(),
    logoAr: logoUrlSchema.optional(),
    navMenu: z.array(navItemSchema).max(MAX_NAV_ITEMS).optional(),
    footerLinks: z
      .object({
        shop: z.array(footerLinkSchema).max(MAX_FOOTER_LINKS_PER_COLUMN).optional(),
        support: z.array(footerLinkSchema).max(MAX_FOOTER_LINKS_PER_COLUMN).optional(),
        company: z.array(footerLinkSchema).max(MAX_FOOTER_LINKS_PER_COLUMN).optional(),
        newsletterEnabled: z.boolean().optional(),
        bottomBar: footerBottomBarSchema.optional(),
      })
      .strict()
      .optional(),
    utilityBar: z
      .object({
        enabled: z.boolean().optional(),
        links: z.array(utilityLinkSchema).max(MAX_UTILITY_LINKS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DraftChrome = z.infer<typeof draftChromeSchema>;
export type DraftNavItem = z.infer<typeof navItemSchema>;
export type DraftFooterLink = z.infer<typeof footerLinkSchema>;
export type DraftUtilityLink = z.infer<typeof utilityLinkSchema>;

export const FOOTER_COLUMNS = ['shop', 'support', 'company'] as const;
export type FooterColumn = (typeof FOOTER_COLUMNS)[number];

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const clean = (s: string | undefined) => (s ?? '').trim();
const optional = (s: string | undefined) => clean(s) || undefined;

/** Blank rows and unsafe hrefs dropped; text trimmed (what the classic save does). */
function cleanNav(items: DraftNavItem[]) {
  return items
    .map(i => ({ label: clean(i.label), labelAr: optional(i.labelAr), href: clean(i.href) }))
    .filter(i => i.label && i.href && isSafeUrl(i.href));
}

function cleanFooter(items: DraftFooterLink[]) {
  return items
    .map(i => ({
      name: clean(i.name),
      nameAr: optional(i.nameAr),
      href: clean(i.href),
      enabled: i.enabled ?? true,
    }))
    .filter(i => i.name && i.href && isSafeUrl(i.href));
}

function cleanUtility(items: DraftUtilityLink[]) {
  return items
    .map(i => ({
      label: clean(i.label),
      labelAr: optional(i.labelAr),
      href: clean(i.href),
      enabled: i.enabled ?? true,
    }))
    .filter(i => i.label && i.href && isSafeUrl(i.href));
}

/** True when the patch carries at least one key (an empty `{}` is a no-op). */
export function hasChromePatch(chrome: DraftChrome | undefined): chrome is DraftChrome {
  return !!chrome && Object.keys(chrome).length > 0;
}

/**
 * `stores.settings` after publishing `patch` over `live`: only the keys the
 * patch carries change, everything else (including legacy footer keys such as
 * `bottomBar`) is preserved. An all-blank menu is ignored, like the classic
 * editor, which refuses to save an empty navigation.
 */
export function applyChromePatch(
  live: unknown,
  patch: DraftChrome | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...asObject(live) };
  if (!patch) return out;
  if (patch.navMenu) {
    const nav = cleanNav(patch.navMenu);
    if (nav.length > 0) out.navMenu = nav;
  }
  if (patch.footerLinks) {
    const next: Record<string, unknown> = { ...asObject(out.footerLinks) };
    for (const col of FOOTER_COLUMNS) {
      const links = patch.footerLinks[col];
      if (links) next[col] = cleanFooter(links);
    }
    if (patch.footerLinks.newsletterEnabled !== undefined)
      next.newsletterEnabled = patch.footerLinks.newsletterEnabled;
    // Merged key by key: a patch that only flips one toggle never drops the rest.
    if (patch.footerLinks.bottomBar)
      next.bottomBar = { ...asObject(next.bottomBar), ...patch.footerLinks.bottomBar };
    out.footerLinks = next;
  }
  if (patch.utilityBar) {
    const next: Record<string, unknown> = { ...asObject(out.utilityBar) };
    if (patch.utilityBar.enabled !== undefined) next.enabled = patch.utilityBar.enabled;
    if (patch.utilityBar.links) next.links = cleanUtility(patch.utilityBar.links);
    out.utilityBar = next;
  }
  return out;
}

/**
 * The `stores.logo` / `stores.logoAr` COLUMNS a publish writes for `patch`. The logo is not part
 * of `settings`, so it rides the same `stores` update as a column patch. A blank or absent key
 * leaves the live logo alone (there is no clear: the classic Branding tab owns removal).
 */
export function chromeLogoColumns(patch: DraftChrome | undefined): {
  logo?: string;
  logoAr?: string;
} {
  const out: { logo?: string; logoAr?: string } = {};
  for (const key of ['logo', 'logoAr'] as const) {
    const v = clean(patch?.[key]);
    if (v && isSafeUrl(v) && !/^(mailto|tel):/i.test(v)) out[key] = v;
  }
  return out;
}

/**
 * The `draftSettings` shape the storefront chrome already understands
 * (`ShopChrome` prefers it over `store.settings`): the patch laid over the live
 * settings, for the editor canvas only. Unlike `applyChromePatch` it keeps
 * blank rows out too, so the canvas shows what publish would produce.
 */
export function chromePreviewSettings(
  live: unknown,
  patch: DraftChrome | undefined
): Record<string, unknown> | null {
  if (!hasChromePatch(patch)) return null;
  const merged = applyChromePatch(live, patch);
  const out: Record<string, unknown> = {};
  for (const key of ['navMenu', 'footerLinks', 'utilityBar'] as const)
    if (key in patch && merged[key] !== undefined) out[key] = merged[key];
  return out;
}
