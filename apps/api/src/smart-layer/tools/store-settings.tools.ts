/**
 * Wave 1 (plan 4 B6): store-settings tools. Every tool is declared with `change()` from ./kit and calls the SAME `StoreService` method the admin route calls
 * (routes/store.routes.ts). The gate of each is the route's own `authorize('store_admin', ...)` (+ `requireFeature` where the route has one).
 *
 * What is deliberately NOT here (never reachable by the assistant): slug, domain, currency, plan, status, timezone, `settings` keys that are server-owned
 * (`packages/shared/src/server-owned-settings.ts`: the Ebda Chat link flag, goldAllowDeferredPayment, mcpWriteEnabled, assistantMode, autoRecommendationsEnabled),
 * payment secrets, uploads (logo / favicon / hero image need a file), the layout hero slides (inline in store-layout.routes.ts) and fonts (read-only route,
 * the builder publish is the only typography writer, Ruling TYPO-WRITER-1).
 */
import { z, type ZodTypeAny } from 'zod/v3';
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import { getLook, isSafeUrl, normalizeEgyptianMobile } from '@ebda/shared';
import { storeDb } from '../../lib/repo-factory';
import { StoreService, type SocialLinksPatch } from '../../services/store.service';
import { change, diffRows, f, pair, pick, row, shape } from './kit';

type Field = ReturnType<typeof f.str>;
type Rec = Record<string, unknown>;
const STORE_ROLES = ['store_admin'] as const; // the routes' `authorize('store_admin', 'super_admin')`; a super admin never acts through the assistant

// ---- small builders shared with seo.tools.ts -----------------------------------------------------------------------------------------------
export const fld = (zt: ZodTypeAny, js: Rec): Field => ({ z: zt, js });
/** A text value: set it, or `null` to clear it. */
export const txt = (description: string, max = 500): Field =>
  f.nullable(f.text(description + ' null clears it.', { max }));
/** A link that is rendered into an `<a href>`: relative path or http(s)/mailto/tel only (the routes' `safeOptionalUrl`). `''` / null clears it. */
export const safeUrl = (description: string, max = 500): Field =>
  f.nullable(
    fld(
      z.preprocess(
        v => (v === '' ? null : v),
        z
          .string()
          .trim()
          .max(max)
          .refine(isSafeUrl, { message: 'link must be a relative path or http(s)/mailto/tel' })
          .nullable()
      ),
      { type: 'string', maxLength: max, description: description + ' null clears it.' }
    )
  );

/** Reads exactly the listed columns of THIS store (ctx.storeId, never an argument). Runs inside `readInStoreContext` (kit) so RLS sees the store. */
export async function readStoreRow(ctx: TurnCtx, select: Record<string, true>): Promise<Rec> {
  const r = await (
    await storeDb(ctx.storeId)
  ).store.findUnique({ where: { id: ctx.storeId }, select: select as { id: true } });
  if (!r) throw new Error('store not found');
  return r as unknown as Rec;
}

type Labels = Record<string, [string, string]>;
type KeyedDef = {
  name: string;
  capabilityId: string;
  description: string;
  fields: Record<string, Field>;
  labels: Labels;
  select: Record<string, true>;
  /** The current value of every key a call may send, by that key's name (missing = null). */
  current: (row: Rec) => Rec;
  feature?: 'seo' | 'floating_widget';
  audit: string;
  summary: { ar: string; en: string };
  /** Extra card flags / words decided from the change (e.g. a switch that takes the store off Google). */
  extra?: (a: Rec, st: Rec) => { touchesCheckout?: boolean; note?: { ar: string; en: string } };
  run: (ctx: TurnCtx, patch: Rec) => Promise<unknown>;
};

/** A tool that sets some keys of one store row: preview rows are the sent keys, the inverse is the same tool with the BEFORE values of exactly those keys. */
export function keyedTool(d: KeyedDef): ToolSpec {
  const base = shape<Rec>(d.fields, []);
  const schema = {
    jsonSchema: base.jsonSchema,
    args: base.args.refine(o => Object.keys(o).length > 0, { message: 'send at least one field' }),
  };
  return change<Rec>({
    name: d.name,
    capabilityId: d.capabilityId,
    description: d.description,
    schema,
    undo: 'reversible',
    gate: { roles: STORE_ROLES, ...(d.feature ? { feature: d.feature } : {}) },
    audit: { action: d.audit, resourceType: 'store' },
    state: async ctx => d.current(await readStoreRow(ctx, d.select)),
    describe: (_ctx, a, st) => {
      const keys = Object.keys(a);
      const x = d.extra?.(a, st as Rec);
      return {
        summary: pair(
          `${d.summary.ar} (${keys.length})${x?.note ? ' - ' + x.note.ar : ''}`,
          `${d.summary.en} (${keys.length})${x?.note ? ' - ' + x.note.en : ''}`
        ),
        rows: diffRows(d.labels, st as Rec, a),
        affectedCount: 1,
        restore: pick(st as Rec, keys),
        ...(x?.touchesCheckout ? { touchesCheckout: true } : {}),
      };
    },
    run: (ctx, a) => d.run(ctx, a),
    inverse: (_a, restore) =>
      restore && Object.keys(restore as Rec).length > 0 ? { tool: d.name, args: restore } : null,
  });
}

// ---- store.settings: contact, social links, names and descriptions -------------------------------------------------------------------------
const CONTACT = [
  'email',
  'phone',
  'phoneAr',
  'whatsapp',
  'address',
  'addressAr',
  'businessHours',
  'googleMapsUrl',
] as const;
const BRAND = ['name', 'nameAr', 'description', 'descriptionAr'] as const;
const SOCIAL = [
  'facebook',
  'instagram',
  'twitter',
  'tiktok',
  'youtube',
  'snapchat',
  'linkedin',
  'wikidata',
  'wikipedia',
] as const;

const whatsappField = f.nullable(
  fld(
    z.preprocess(
      v => (typeof v === 'string' && v.trim() === '' ? null : v),
      z
        .string()
        .max(50)
        .transform((v, c) => {
          const e164 = normalizeEgyptianMobile(v);
          if (!e164) {
            c.addIssue({ code: z.ZodIssueCode.custom, message: 'not an Egyptian mobile number' });
            return z.NEVER;
          }
          return e164;
        })
        .nullable()
    ),
    {
      type: 'string',
      maxLength: 50,
      description:
        'The store WhatsApp number, an Egyptian mobile (010, 011, 012 or 015). null clears it.',
    }
  )
);

const SETTINGS_LABELS: Labels = {
  email: ['ايميل المتجر', 'Store e-mail'],
  phone: ['رقم التليفون', 'Phone'],
  phoneAr: ['رقم التليفون (عربي)', 'Phone (Arabic)'],
  whatsapp: ['رقم الواتساب', 'WhatsApp number'],
  address: ['العنوان', 'Address'],
  addressAr: ['العنوان (عربي)', 'Address (Arabic)'],
  businessHours: ['مواعيد العمل', 'Business hours'],
  googleMapsUrl: ['لينك الموقع على خرائط جوجل', 'Google Maps link'],
  name: ['اسم المتجر', 'Store name'],
  nameAr: ['اسم المتجر (عربي)', 'Store name (Arabic)'],
  description: ['وصف المتجر', 'Store description'],
  descriptionAr: ['وصف المتجر (عربي)', 'Store description (Arabic)'],
  facebook: ['لينك فيسبوك', 'Facebook link'],
  instagram: ['لينك انستجرام', 'Instagram link'],
  twitter: ['لينك تويتر / X', 'Twitter / X link'],
  tiktok: ['لينك تيك توك', 'TikTok link'],
  youtube: ['لينك يوتيوب', 'YouTube link'],
  snapchat: ['لينك سناب شات', 'Snapchat link'],
  linkedin: ['لينك لينكدإن', 'LinkedIn link'],
  wikidata: ['لينك ويكي داتا', 'Wikidata link'],
  wikipedia: ['لينك ويكيبيديا', 'Wikipedia link'],
};

const settingsFields: Record<string, Field> = {
  email: f.nullable(
    fld(z.string().trim().email().max(255), {
      type: 'string',
      format: 'email',
      maxLength: 255,
      description: 'Store contact e-mail.',
    })
  ),
  phone: txt('Store phone number.', 50),
  phoneAr: txt('Store phone number shown in Arabic.', 50),
  whatsapp: whatsappField,
  address: txt('Store address.', 500),
  addressAr: txt('Store address in Arabic.', 500),
  businessHours: txt('Opening hours as free text.', 500),
  googleMapsUrl: txt('Full Google Maps link of the store.', 2000),
  name: f.str('Store name (cannot be cleared).', { max: 200 }),
  nameAr: txt('Store name in Arabic.', 200),
  description: txt('Store description.', 1000),
  descriptionAr: txt('Store description in Arabic.', 1000),
  ...Object.fromEntries(SOCIAL.map(k => [k, safeUrl(`The store ${k} link.`)])),
};

const storeSettingsUpdate = keyedTool({
  name: 'store_settings_update',
  capabilityId: 'store.settings',
  description:
    'Change the store contact details (e-mail, phone, WhatsApp number, address, opening hours, Maps link), social links, store name and description. Send only the fields to change; null clears a value (not the name). It never touches currency, plan, domain, slug, payment or assistant switches.',
  fields: settingsFields,
  labels: SETTINGS_LABELS,
  select: {
    email: true,
    phone: true,
    phoneAr: true,
    whatsapp: true,
    address: true,
    addressAr: true,
    businessHours: true,
    googleMapsUrl: true,
    name: true,
    nameAr: true,
    description: true,
    descriptionAr: true,
    socialLinks: true,
  },
  current: r => {
    const links = (r.socialLinks as Rec | null) ?? {};
    return {
      ...Object.fromEntries([...CONTACT, ...BRAND].map(k => [k, r[k] ?? null])),
      ...Object.fromEntries(SOCIAL.map(k => [k, links[k] ?? null])),
    };
  },
  audit: 'store.settings.updated',
  summary: pair('هعدّل بيانات المتجر', 'Update store details'),
  // routes/store.routes.ts PUT /:id/branding-bundle: ONE transaction for the contact, social and branding parts.
  run: (ctx, patch) => {
    const contact: Rec = {};
    const branding: Rec = {};
    const social: SocialLinksPatch = { set: {}, remove: [] };
    for (const [k, v] of Object.entries(patch)) {
      if ((CONTACT as readonly string[]).includes(k)) contact[k] = v;
      else if ((BRAND as readonly string[]).includes(k)) branding[k] = v;
      else if (v === null || v === undefined) social.remove.push(k);
      else social.set[k] = String(v);
    }
    return StoreService.updateBrandingBundle(ctx.storeId, {
      ...(Object.keys(contact).length ? { contact: contact as never } : {}),
      ...(Object.keys(branding).length ? { branding: branding as never } : {}),
      ...(social.remove.length || Object.keys(social.set).length ? { social } : {}),
    });
  },
});

// ---- store.branding: colours (logo / favicon need an upload and stay on the screen) -------------------------------------------------------------
const COLOURS = [
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'backgroundColor',
  'textColor',
] as const;
// A colour the model sends is a hex value, but the stored one may be a theme token or hsl()/rgb(), and the undo must be able to put it back.
const COLOUR_RE = /^(|#[0-9a-fA-F]{3,8}|token:[\w-]{1,40}|(?:hsl|rgb)a?\([\d\s.,%/-]{1,40}\))$/;
const hex = (d: string): Field =>
  f.nullable(
    fld(z.string().trim().regex(COLOUR_RE), {
      type: 'string',
      pattern: COLOUR_RE.source,
      description: `${d} as a hex colour like #B08D57. null resets it to the look's own colour.`,
    })
  );
const brandingUpdate = keyedTool({
  name: 'branding_update',
  capabilityId: 'store.branding',
  description:
    'Change the store colours (primary, secondary, accent, background, text). null resets a colour to the look default. It cannot upload or change the logo.',
  fields: Object.fromEntries(COLOURS.map(k => [k, hex(k)])),
  labels: {
    primaryColor: ['اللون الأساسي', 'Primary colour'],
    secondaryColor: ['اللون الثانوي', 'Secondary colour'],
    accentColor: ['لون التمييز', 'Accent colour'],
    backgroundColor: ['لون الخلفية', 'Background colour'],
    textColor: ['لون النص', 'Text colour'],
  },
  select: { theme: true },
  current: r =>
    Object.fromEntries(COLOURS.map(k => [k, ((r.theme as Rec | null) ?? {})[k] ?? null])),
  audit: 'store.branding.updated',
  summary: pair('هغيّر ألوان المتجر', 'Change store colours'),
  // routes/store.routes.ts PUT /:id/branding-bundle (theme part); a null deletes the key (StoreService.updateTheme).
  run: (ctx, patch) => StoreService.updateBrandingBundle(ctx.storeId, { theme: patch }),
});

// ---- store.announcement ------------------------------------------------------------------------------------------------------------------------
const ANN = [
  'enabled',
  'text',
  'textAr',
  'link',
  'linkText',
  'linkTextAr',
  'dismissible',
  'bgColor',
  'textColor',
] as const;
const announcementSet = keyedTool({
  name: 'announcement_set',
  capabilityId: 'store.announcement',
  description:
    'Set the announcement bar above the store (text in English and Arabic, link, colours, on/off, dismissible). Send only the fields to change; the rest of the bar is kept.',
  fields: {
    enabled: f.nullable(f.bool('Show the bar. null = not set.')),
    text: f.nullable(f.text('Bar text in English.', { max: 500 })),
    textAr: f.nullable(f.text('Bar text in Arabic.', { max: 500 })),
    link: safeUrl('Where the bar links to.'),
    linkText: txt('Link label in English.', 200),
    linkTextAr: txt('Link label in Arabic.', 200),
    dismissible: f.nullable(f.bool('Shoppers can close the bar. null = not set.')),
    bgColor: txt('Background colour.', 50),
    textColor: txt('Text colour.', 50),
  },
  labels: {
    enabled: ['إظهار الشريط', 'Show the bar'],
    text: ['نص الإعلان', 'Text'],
    textAr: ['نص الإعلان (عربي)', 'Text (Arabic)'],
    link: ['لينك الإعلان', 'Link'],
    linkText: ['كلمة اللينك', 'Link label'],
    linkTextAr: ['كلمة اللينك (عربي)', 'Link label (Arabic)'],
    dismissible: ['يتقفل بزرار', 'Can be closed'],
    bgColor: ['لون الخلفية', 'Background colour'],
    textColor: ['لون النص', 'Text colour'],
  },
  select: { announcementBar: true },
  current: r =>
    Object.fromEntries(ANN.map(k => [k, ((r.announcementBar as Rec | null) ?? {})[k] ?? null])),
  audit: 'store.announcement.updated',
  summary: pair('هعدّل شريط الإعلان', 'Update the announcement bar'),
  // routes/store.routes.ts PUT /:id/announcement (shallow merge into the stored bar).
  run: (ctx, patch) => StoreService.updateAnnouncementBar(ctx.storeId, patch),
});

// ---- store.hero: the text hero (legacy fallback fields; slides and images live in the layout editor) ---------------------------------------------
const HERO = [
  'heroTitle',
  'heroTitleAr',
  'heroSubtitle',
  'heroSubtitleAr',
  'heroCtaText',
  'heroCtaTextAr',
  'heroCtaLink',
] as const;
const heroSet = keyedTool({
  name: 'hero_set',
  capabilityId: 'store.hero',
  description:
    'Set the home page hero text: title, subtitle and button text in English and Arabic, and the button link. null clears a field. It cannot change hero images or slides.',
  fields: {
    heroTitle: txt('Hero title.', 200),
    heroTitleAr: txt('Hero title in Arabic.', 200),
    heroSubtitle: txt('Hero subtitle.', 500),
    heroSubtitleAr: txt('Hero subtitle in Arabic.', 500),
    heroCtaText: txt('Hero button text.', 100),
    heroCtaTextAr: txt('Hero button text in Arabic.', 100),
    heroCtaLink: safeUrl('Where the hero button goes.'),
  },
  labels: {
    heroTitle: ['عنوان البانر', 'Hero title'],
    heroTitleAr: ['عنوان البانر (عربي)', 'Hero title (Arabic)'],
    heroSubtitle: ['النص التعريفي', 'Hero subtitle'],
    heroSubtitleAr: ['النص التعريفي (عربي)', 'Hero subtitle (Arabic)'],
    heroCtaText: ['كلمة الزرار', 'Button text'],
    heroCtaTextAr: ['كلمة الزرار (عربي)', 'Button text (Arabic)'],
    heroCtaLink: ['لينك الزرار', 'Button link'],
  },
  select: Object.fromEntries(HERO.map(k => [k, true as const])),
  current: r => Object.fromEntries(HERO.map(k => [k, r[k] ?? null])),
  audit: 'store.hero.updated',
  summary: pair('هعدّل نص بانر الصفحة الرئيسية', 'Update the home page hero text'),
  // routes/store.routes.ts PUT /:id (hero columns only; heroImage is not offered).
  run: (ctx, patch) => StoreService.update(ctx.storeId, patch as never),
});

// ---- store.navigation-menu ---------------------------------------------------------------------------------------------------------------------
const href = fld(
  z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(isSafeUrl, { message: 'link must be a relative path or http(s)/mailto/tel' }),
  { type: 'string', maxLength: 500, description: 'A store path like /products or a full link.' }
);
const navItem = f.obj(
  {
    label: f.str('English label.', { max: 80 }),
    labelAr: f.str('Arabic label.', { max: 80 }),
    href,
  },
  ['label', 'href']
);
const footerItem = f.obj(
  {
    name: f.str('English label.', { max: 80 }),
    nameAr: f.str('Arabic label.', { max: 80 }),
    href,
    enabled: f.bool('false hides this link.'),
  },
  ['name', 'href']
);
const FOOTER_COLS = ['footerShop', 'footerSupport', 'footerCompany'] as const;
const colOf = (k: string) => k.replace('footer', '').toLowerCase();
type MenuArgs = { navMenu?: unknown[] | null } & {
  [k in (typeof FOOTER_COLS)[number]]?: unknown[];
};
const menuBase = shape<MenuArgs>(
  {
    navMenu: f.nullable(
      f.list(navItem, {
        min: 1,
        max: 12,
        description: 'The header menu, in order. null resets it to the default menu.',
      })
    ),
    ...Object.fromEntries(
      FOOTER_COLS.map(k => [
        k,
        f.list(footerItem, {
          max: 12,
          description: `Footer column "${colOf(k)}", in order. [] empties it.`,
        }),
      ])
    ),
  },
  []
);
const menuUpdate = change<MenuArgs>({
  name: 'menu_update',
  capabilityId: 'store.navigation-menu',
  description:
    'Replace the header menu and/or the footer link columns (shop, support, company). Send the complete new list for each part you change; other parts are kept.',
  schema: {
    jsonSchema: menuBase.jsonSchema,
    args: menuBase.args.refine(o => Object.keys(o).length > 0, {
      message: 'send at least one part',
    }),
  },
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: { action: 'store.menu.updated', resourceType: 'store' },
  state: async ctx => {
    const s = ((await readStoreRow(ctx, { settings: true })).settings as Rec | null) ?? {};
    const links = (s.footerLinks as Rec | null) ?? {};
    return {
      navMenu: s.navMenu ?? null,
      ...Object.fromEntries(FOOTER_COLS.map(k => [k, links[colOf(k)] ?? []])),
    };
  },
  describe: (_ctx, a, st) => {
    const labels: Labels = {
      navMenu: ['القايمة اللي فوق', 'Header menu'],
      footerShop: ['فوتر: تسوق', 'Footer: shop'],
      footerSupport: ['فوتر: الدعم', 'Footer: support'],
      footerCompany: ['فوتر: الشركة', 'Footer: company'],
    };
    const keys = Object.keys(a);
    return {
      summary: pair('هعدّل قايمة المتجر وروابط الفوتر', 'Update the store menu and footer links'),
      rows: diffRows(labels, st as Rec, a as Rec),
      affectedCount: 1,
      restore: pick(st as Rec, keys),
    };
  },
  // routes/store.routes.ts PUT /:id with `settings` (the navigation editor's save). Top-level key replace: footerLinks is merged here so bottomBar survives.
  run: async (ctx, a, st) => {
    const settings: Rec = {};
    if ('navMenu' in a) settings.navMenu = a.navMenu;
    const cols = FOOTER_COLS.filter(k => k in a);
    if (cols.length) {
      const live = ((await readStoreRow(ctx, { settings: true })).settings as Rec | null) ?? {};
      const footer: Rec = { ...((live.footerLinks as Rec | null) ?? {}) };
      for (const k of cols) footer[colOf(k)] = (a as Rec)[k];
      settings.footerLinks = footer;
    }
    void st;
    return StoreService.update(ctx.storeId, { settings } as never);
  },
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'menu_update', args: restore }
      : null,
});

// ---- store.template-look (a look change is merchant-asked only; typography has no writer the assistant may use) --------------------------------
type LookArgs = { lookId: string };
const lookBase = shape<LookArgs>(
  { lookId: f.str('The look id, like "qamar.noor". Only a look the merchant named.', { max: 40 }) },
  ['lookId']
);
const lookUpdate = change<LookArgs>({
  name: 'look_update',
  capabilityId: 'store.template-look',
  description:
    'Switch the store to another look (template style). Only when the merchant asked for it by name or described it. Their own edits are kept (design "keep"); the home page is re-shaped as a DRAFT they publish themselves.',
  schema: lookBase,
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: { action: 'store.look.applied', resourceType: 'store' },
  state: async ctx => {
    const r = await readStoreRow(ctx, { look: true, template: true });
    return { look: r.look ?? null, template: r.template ?? null };
  },
  describe: (_ctx, a, st) => {
    const target = getLook(a.lookId);
    if (!target) throw new Error(`unknown look ${a.lookId}`);
    const cur = st as { look: string | null; template: string | null };
    if (target.status !== 'built' && cur.look !== target.id)
      throw new Error('that look is not available yet');
    return {
      summary: pair(
        'هغيّر شكل المتجر. الصفحة الرئيسية هتتجهز كمسودة وانت اللي تنشرها',
        'Switch the store look. The home page is prepared as a draft you publish yourself'
      ),
      rows: [
        row('شكل المتجر', 'Store look', cur.look, target.id),
        row('القالب', 'Template', cur.template, target.skin),
      ],
      affectedCount: 1,
      touchesCheckout: true, // the whole storefront, checkout included
      restore: { look: cur.look },
    };
  },
  // routes/store.routes.ts PUT /:id/look.
  run: (ctx, a) => StoreService.applyLook(ctx.storeId, a.lookId, { design: 'keep' }, ctx.userId),
  inverse: (_a, restore) => {
    const before = (restore as { look: string | null } | null)?.look;
    return before ? { tool: 'look_update', args: { lookId: before } } : null; // a bare-template store has no look to switch back to
  },
});

// ---- store.whatsapp-buttons: the floating widget's WhatsApp button (plan feature floating_widget) ---------------------------------------------
type WaArgs = {
  enabled?: boolean;
  position?: string;
  whatsappPhone?: string | null;
  whatsappMessage?: string | null;
  label?: string | null;
  labelAr?: string | null;
};
const waPhone = f.nullable(
  fld(
    z
      .string()
      .max(50)
      .transform((v, c) => {
        const e164 = normalizeEgyptianMobile(v);
        if (!e164) {
          c.addIssue({ code: z.ZodIssueCode.custom, message: 'not an Egyptian mobile number' });
          return z.NEVER;
        }
        return e164.replace('+', '');
      }),
    {
      type: 'string',
      description:
        'The WhatsApp number of the button, an Egyptian mobile. null removes the WhatsApp button.',
    }
  )
);
const waBase = shape<WaArgs>(
  {
    enabled: f.bool('Show the floating button group on the store.'),
    position: f.enum(
      ['br', 'bl', 'tr', 'tl'],
      'Corner of the screen: br bottom-right, bl bottom-left, tr, tl.'
    ),
    whatsappPhone: waPhone,
    whatsappMessage: txt('Message the chat opens with.', 500),
    label: txt('Tooltip in English.', 200),
    labelAr: txt('Tooltip in Arabic.', 200),
  },
  []
);
const WA_KEYS = ['whatsappPhone', 'whatsappMessage', 'label', 'labelAr'] as const;
const waCurrent = (s: Rec | null) => {
  const w = ((s ?? {}).floatingWidget as Rec | null) ?? {};
  const b =
    (Array.isArray(w.buttons) ? (w.buttons as Rec[]) : []).find(x => x.kind === 'whatsapp') ?? {};
  return {
    widget: w,
    state: {
      enabled: w.enabled === true,
      position: (w.position as string | undefined) ?? 'br',
      ...Object.fromEntries(WA_KEYS.map(k => [k, b[k] ?? null])),
    } as Rec,
  };
};
const whatsappButtonsSet = change<WaArgs>({
  name: 'whatsapp_buttons_set',
  capabilityId: 'store.whatsapp-buttons',
  description:
    'Set the WhatsApp button of the storefront floating widget: on/off, corner, the WhatsApp number, the opening message and the tooltip. Other buttons of the widget are kept. Needs the floating widget feature on the plan.',
  schema: {
    jsonSchema: waBase.jsonSchema,
    args: waBase.args.refine(o => Object.keys(o).length > 0, {
      message: 'send at least one field',
    }),
  },
  undo: 'reversible',
  gate: { roles: STORE_ROLES, feature: 'floating_widget' },
  audit: { action: 'store.whatsapp-buttons.updated', resourceType: 'store' },
  state: async ctx =>
    waCurrent((await readStoreRow(ctx, { settings: true })).settings as Rec | null).state,
  describe: (_ctx, a, st) => {
    const labels: Labels = {
      enabled: ['إظهار الأزرار العايمة', 'Show floating buttons'],
      position: ['مكان الزرار', 'Position'],
      whatsappPhone: ['رقم الواتساب', 'WhatsApp number'],
      whatsappMessage: ['رسالة البداية', 'Opening message'],
      label: ['الكلمة على الزرار', 'Tooltip'],
      labelAr: ['الكلمة على الزرار (عربي)', 'Tooltip (Arabic)'],
    };
    return {
      summary: pair('هعدّل زرار الواتساب العايم', 'Update the floating WhatsApp button'),
      rows: diffRows(labels, st as Rec, a as Rec),
      affectedCount: 1,
      restore: pick(st as Rec, Object.keys(a)),
    };
  },
  // routes/store.routes.ts PUT /:id/floating-widget: the route stores the whole widget config, so the live one is merged here (other buttons kept).
  run: async (ctx, a) => {
    const { widget } = waCurrent(
      (await readStoreRow(ctx, { settings: true })).settings as Rec | null
    );
    const buttons = (Array.isArray(widget.buttons) ? [...(widget.buttons as Rec[])] : []) as Rec[];
    const at = buttons.findIndex(b => b.kind === 'whatsapp');
    const next: Rec = { ...widget };
    if (a.enabled !== undefined) next.enabled = a.enabled;
    if (a.position !== undefined) next.position = a.position;
    if (WA_KEYS.some(k => k in a)) {
      if (a.whatsappPhone === null) {
        if (at >= 0) buttons.splice(at, 1);
      } else {
        const cur: Rec = at >= 0 ? { ...buttons[at] } : { id: 'wa-1', kind: 'whatsapp' };
        if (at < 0 && !a.whatsappPhone)
          throw new Error('a WhatsApp number is needed to add the button');
        for (const k of WA_KEYS) {
          if (!(k in (a as Rec))) continue;
          const v = (a as Rec)[k];
          if (v === null) delete cur[k];
          else cur[k] = v;
        }
        if (at >= 0) buttons[at] = cur;
        else buttons.push(cur);
      }
      next.buttons = buttons;
    }
    return StoreService.updateFloatingWidget(ctx.storeId, next);
  },
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'whatsapp_buttons_set', args: restore }
      : null,
});

// ---- store.language: the default storefront language -------------------------------------------------------------------------------------------
type LangArgs = { defaultLanguage: 'ar' | 'en' };
const langBase = shape<LangArgs>(
  { defaultLanguage: f.enum(['ar', 'en'], 'ar = Arabic (right-to-left), en = English.') },
  ['defaultLanguage']
);
const storeLanguageSet = change<LangArgs>({
  name: 'store_language_set',
  capabilityId: 'store.language',
  description:
    "Set the store's default language (Arabic or English). The whole storefront and its web addresses follow it, so only when the merchant asked.",
  schema: langBase,
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: { action: 'store.language.updated', resourceType: 'store' },
  state: async ctx => ({
    defaultLanguage:
      ((await readStoreRow(ctx, { settings: true })).settings as Rec | null)?.defaultLanguage ??
      'en',
  }),
  describe: (_ctx, a, st) => {
    const before = (st as { defaultLanguage: string }).defaultLanguage;
    return {
      summary: pair(
        a.defaultLanguage === 'ar'
          ? 'هخلّي لغة المتجر الأساسية عربي'
          : 'هخلّي لغة المتجر الأساسية إنجليزي',
        `Make ${a.defaultLanguage === 'ar' ? 'Arabic' : 'English'} the default store language`
      ),
      rows: [row('اللغة الأساسية', 'Default language', before, a.defaultLanguage)],
      affectedCount: 1,
      touchesCheckout: true, // changes the language and addresses of every page, checkout included
      restore: { defaultLanguage: before },
    };
  },
  // routes/store.routes.ts PUT /:id with `settings: { defaultLanguage }` (what the language page sends).
  run: (ctx, a) =>
    StoreService.update(ctx.storeId, { settings: { defaultLanguage: a.defaultLanguage } } as never),
  inverse: (_a, restore) => ({ tool: 'store_language_set', args: restore }),
});

export function storeSettingsTools(): ToolSpec[] {
  return [
    storeSettingsUpdate,
    brandingUpdate,
    announcementSet,
    heroSet,
    menuUpdate,
    lookUpdate,
    whatsappButtonsSet,
    storeLanguageSet,
  ];
}
