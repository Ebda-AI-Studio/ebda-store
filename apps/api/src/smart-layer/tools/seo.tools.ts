/**
 * Wave 1 (plan 4 B6): seo. Both tools call `StoreService.updateSeo`, the service behind `PUT /stores/:id/seo` (routes/store.routes.ts), whose gate is
 * `authorize('store_admin')` + `requireFeature('seo')`. Not offered: ogImage (needs an upload), the Search Console verification token and the e-mail sender
 * prefix (not search copy). Product and page SEO fields belong to the products / content tools (ProductService.update); pages.routes.ts has no SEO fields.
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { f } from './kit';
import { keyedTool, txt } from './store-settings.tools';
import { StoreService } from '../../services/store.service';

const SEO = [
  'metaTitle',
  'metaTitleAr',
  'metaDescription',
  'metaDescriptionAr',
  'twitterHandle',
  'hideFromSearchEngines',
] as const;

const seoMetaUpdate = keyedTool({
  name: 'seo_meta_update',
  capabilityId: 'store.seo',
  description:
    'Set how the store looks on Google: the home page title and description (English and Arabic), the Twitter handle, and the switch that hides the whole store from search engines. null clears a text value. Hiding the store from search engines removes it from Google, so only when the merchant clearly asked.',
  fields: {
    metaTitle: txt('Search result title in English.', 200),
    metaTitleAr: txt('Search result title in Arabic.', 200),
    metaDescription: txt('Search result description in English.', 500),
    metaDescriptionAr: txt('Search result description in Arabic.', 500),
    twitterHandle: txt('Twitter / X handle.', 50),
    hideFromSearchEngines: f.bool('true hides the whole store from search engines.'),
  },
  labels: {
    metaTitle: ['عنوان جوجل', 'Google title'],
    metaTitleAr: ['عنوان جوجل (عربي)', 'Google title (Arabic)'],
    metaDescription: ['وصف جوجل', 'Google description'],
    metaDescriptionAr: ['وصف جوجل (عربي)', 'Google description (Arabic)'],
    twitterHandle: ['حساب تويتر', 'Twitter handle'],
    hideFromSearchEngines: ['إخفاء المتجر من محركات البحث', 'Hide from search engines'],
  },
  feature: 'seo',
  select: {
    metaTitle: true,
    metaTitleAr: true,
    metaDescription: true,
    metaDescriptionAr: true,
    twitterHandle: true,
    settings: true,
  },
  current: r => ({
    ...Object.fromEntries(SEO.slice(0, 5).map(k => [k, r[k] ?? null])),
    hideFromSearchEngines:
      ((r.settings as Record<string, unknown> | null) ?? {}).hideFromSearchEngines === true,
  }),
  audit: 'store.seo.updated',
  summary: { ar: 'هعدّل ظهور المتجر في جوجل', en: 'Update how the store appears on Google' },
  // Hiding the store removes it from Google in one click: a merchant confirms it (touchesCheckout makes the engine ask for confirm).
  extra: (a, st) =>
    a.hideFromSearchEngines === true && st.hideFromSearchEngines !== true
      ? {
          touchesCheckout: true,
          note: {
            ar: 'المتجر هيختفي من نتايج جوجل ومحركات البحث لحد ما ترجّعه',
            en: 'the store disappears from Google and other search engines until you turn this back',
          },
        }
      : {},
  // routes/store.routes.ts PUT /:id/seo
  run: (ctx, patch) => StoreService.updateSeo(ctx.storeId, patch as never),
});

const answerEngineSettings = keyedTool({
  name: 'answer_engine_settings',
  capabilityId: 'store.answer-engine',
  description:
    'Set the short conversational store description that answer engines such as ChatGPT read (English and Arabic, up to 400 characters). null clears it. Reports and bulk sweeps stay on the Answer-engine screen.',
  fields: {
    metaDescriptionAeo: txt('Conversational description in English.', 400),
    metaDescriptionAeoAr: txt('Conversational description in Arabic.', 400),
  },
  labels: {
    metaDescriptionAeo: ['وصف محركات الإجابة', 'Answer-engine description'],
    metaDescriptionAeoAr: ['وصف محركات الإجابة (عربي)', 'Answer-engine description (Arabic)'],
  },
  feature: 'seo', // the route that writes these two columns is PUT /:id/seo
  select: { metaDescriptionAeo: true, metaDescriptionAeoAr: true },
  current: r => ({
    metaDescriptionAeo: r.metaDescriptionAeo ?? null,
    metaDescriptionAeoAr: r.metaDescriptionAeoAr ?? null,
  }),
  audit: 'store.answer-engine.updated',
  summary: { ar: 'هعدّل وصف المتجر لمحركات الإجابة', en: 'Update the answer-engine description' },
  // routes/store.routes.ts PUT /:id/seo (metaDescriptionAeo / metaDescriptionAeoAr)
  run: (ctx, patch) => StoreService.updateSeo(ctx.storeId, patch as never),
});

export function seoTools(): ToolSpec[] {
  return [seoMetaUpdate, answerEngineSettings];
}
