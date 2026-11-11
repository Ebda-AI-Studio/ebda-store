'use client';

/**
 * AiSweepResultsPanels
 * Five collapsible result viewers for the AI sweep outputs that didn't
 * have a dedicated UI: translate, seo, faqs, howtos, meta-aeo.
 * Placed below the existing sweep action cards on the AI Tools page.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { apiGet } from '../../../../../lib/api';
import { useT } from '@/i18n/useT';
import { withNumerals } from '@ebda/shared';
import { Button } from '@/components/ui/Button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranslateResult {
  products: { total: number; filled: number; fillRate: number };
  categories: { total: number; filled: number; fillRate: number };
  recentlyTranslated: Array<{
    id: string;
    name: string;
    nameAr: string | null;
    updatedAt: string;
  }>;
}

interface SeoResult {
  storeMetaFilled: boolean;
  products: { total: number; filled: number; fillRate: number };
  categories: { total: number; filled: number; fillRate: number };
  recentProducts: Array<{
    id: string;
    name: string;
    metaTitle: string | null;
    metaDescription: string | null;
    updatedAt: string;
  }>;
}

interface FaqItem {
  id: string;
  question: string;
  questionAr: string | null;
  answerPreview: string;
  answerArPreview: string | null;
  aiDrafted: boolean;
  manuallyEdited: boolean;
  updatedAt: string;
}

interface FaqResult {
  count: number;
  lastUpdated: string | null;
  faqs: FaqItem[];
}

interface HowtoItem {
  id: string;
  title: string;
  titleAr: string | null;
  descriptionPreview: string;
  stepCount: number;
  aiDrafted: boolean;
  manuallyEdited: boolean;
  updatedAt: string;
}

interface HowtoResult {
  count: number;
  lastUpdated: string | null;
  howtos: HowtoItem[];
}

interface MetaAeoResult {
  storeAeoFilled: boolean;
  storeMetaDescriptionAeo: string | null;
  products: { total: number; filled: number; fillRate: number };
  categories: { total: number; filled: number; fillRate: number };
  recentProducts: Array<{
    id: string;
    name: string;
    metaDescriptionAeo: string | null;
    updatedAt: string;
  }>;
}

interface CategorizeResult {
  products: { total: number; filled: number; fillRate: number };
  recentProducts: Array<{
    id: string;
    name: string;
    categoryName: string | null;
    updatedAt: string;
  }>;
}

interface ImageAltResult {
  images: { total: number; filled: number; fillRate: number };
}

interface ExcerptResult {
  products: { total: number; filled: number; fillRate: number };
  recentProducts: Array<{
    id: string;
    name: string;
    excerpt: string | null;
    excerptAr: string | null;
    updatedAt: string;
  }>;
}

interface TagsResult {
  products: { total: number; filled: number; fillRate: number };
  totalTags: number;
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function AiSweepResultsPanels({ storeId }: { storeId: string }) {
  const t = useT('aiTools.sweepResults');
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const [translate, setTranslate] = useState<TranslateResult | null>(null);
  const [seo, setSeo] = useState<SeoResult | null>(null);
  const [faqs, setFaqs] = useState<FaqResult | null>(null);
  const [howtos, setHowtos] = useState<HowtoResult | null>(null);
  const [metaAeo, setMetaAeo] = useState<MetaAeoResult | null>(null);
  const [categorize, setCategorize] = useState<CategorizeResult | null>(null);
  const [imageAlt, setImageAlt] = useState<ImageAltResult | null>(null);
  const [excerpt, setExcerpt] = useState<ExcerptResult | null>(null);
  const [tags, setTags] = useState<TagsResult | null>(null);

  const fetchAll = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const base = `/api/v1/stores/${storeId}/ai/results`;
    const [t, s, f, h, m, c, ia, ex, tg] = await Promise.allSettled([
      apiGet<TranslateResult>(`${base}/translate`),
      apiGet<SeoResult>(`${base}/seo`),
      apiGet<FaqResult>(`${base}/faqs`),
      apiGet<HowtoResult>(`${base}/howtos`),
      apiGet<MetaAeoResult>(`${base}/meta-aeo`),
      apiGet<CategorizeResult>(`${base}/categorize`),
      apiGet<ImageAltResult>(`${base}/image-alt`),
      apiGet<ExcerptResult>(`${base}/excerpt`),
      apiGet<TagsResult>(`${base}/tags`),
    ]);
    if (t.status === 'fulfilled' && t.value.data) setTranslate(t.value.data);
    if (s.status === 'fulfilled' && s.value.data) setSeo(s.value.data);
    if (f.status === 'fulfilled' && f.value.data) setFaqs(f.value.data);
    if (h.status === 'fulfilled' && h.value.data) setHowtos(h.value.data);
    if (m.status === 'fulfilled' && m.value.data) setMetaAeo(m.value.data);
    if (c.status === 'fulfilled' && c.value.data) setCategorize(c.value.data);
    if (ia.status === 'fulfilled' && ia.value.data) setImageAlt(ia.value.data);
    if (ex.status === 'fulfilled' && ex.value.data) setExcerpt(ex.value.data);
    if (tg.status === 'fulfilled' && tg.value.data) setTags(tg.value.data);
    setLoading(false);
    setLastFetched(new Date());
  }, [storeId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return (
    <div className="mt-8">
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">{t('header')}</h2>
        <Button variant="outline" size="sm" type="button" onClick={fetchAll} disabled={loading}>
          {loading ? (
            <SpinIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshIcon className="h-3.5 w-3.5" />
          )}
          <span>{loading ? t('refreshing') : t('refresh')}</span>
        </Button>
      </div>
      {lastFetched && (
        <p className="mb-3 text-xs text-muted-foreground">
          {t('lastFetched', { time: lastFetched.toLocaleTimeString(undefined, withNumerals()) })}
        </p>
      )}

      {/* Panels stacked */}
      <div className="flex flex-col gap-3">
        <CollapsiblePanel
          title={t('panels.translate.title')}
          badge={translate ? `${pct(translate.products.fillRate)}% products` : undefined}
        >
          {translate ? <TranslatePanel data={translate} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.seo.title')}
          badge={seo ? `${pct(seo.products.fillRate)}% products` : undefined}
        >
          {seo ? <SeoPanel data={seo} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.faq.title')}
          badge={faqs ? `${faqs.count} FAQ${faqs.count !== 1 ? 's' : ''}` : undefined}
        >
          {faqs ? <FaqPanel data={faqs} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.howto.title')}
          badge={howtos ? `${howtos.count} guide${howtos.count !== 1 ? 's' : ''}` : undefined}
        >
          {howtos ? <HowtoPanel data={howtos} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.metaAeo.title')}
          badge={metaAeo ? `${pct(metaAeo.products.fillRate)}% products` : undefined}
        >
          {metaAeo ? <MetaAeoPanel data={metaAeo} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.categorize.title')}
          badge={categorize ? `${pct(categorize.products.fillRate)}% products` : undefined}
        >
          {categorize ? <CategorizePanel data={categorize} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.imageAlt.title')}
          badge={imageAlt ? `${pct(imageAlt.images.fillRate)}% images` : undefined}
        >
          {imageAlt ? <ImageAltPanel data={imageAlt} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.excerpt.title')}
          badge={excerpt ? `${pct(excerpt.products.fillRate)}% products` : undefined}
        >
          {excerpt ? <ExcerptPanel data={excerpt} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>

        <CollapsiblePanel
          title={t('panels.tags.title')}
          badge={tags ? `${pct(tags.products.fillRate)}% products` : undefined}
        >
          {tags ? <TagsPanel data={tags} storeId={storeId} /> : <Loading />}
        </CollapsiblePanel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual panel bodies
// ---------------------------------------------------------------------------

function TranslatePanel({ data, storeId }: { data: TranslateResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-4">
      {/* Fill-rate cards side-by-side */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FillRateCard
          label={t('fillRateLabels.productsAr')}
          filled={data.products.filled}
          total={data.products.total}
          rate={data.products.fillRate}
        />
        <FillRateCard
          label={t('fillRateLabels.categoriesAr')}
          filled={data.categories.filled}
          total={data.categories.total}
          rate={data.categories.fillRate}
        />
      </div>

      {/* Recent rows */}
      {data.recentlyTranslated.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('recentlyTranslated')}
          </p>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {data.recentlyTranslated.map(p => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <span className="font-medium">{p.name}</span>
                  {p.nameAr && (
                    <span className="ms-2 text-muted-foreground" dir="rtl">
                      {p.nameAr}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {relativeDate(p.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Link */}
      <Link
        href={`/stores/${storeId}/products`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('openCatalogProducts')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function SeoPanel({ data, storeId }: { data: SeoResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard not available in non-https
    }
  }

  return (
    <div className="space-y-4">
      {/* 3 fill-rate cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FillRateCard
          label={t('fillRateLabels.store')}
          filled={data.storeMetaFilled ? 1 : 0}
          total={1}
          rate={data.storeMetaFilled ? 1 : 0}
        />
        <FillRateCard
          label={t('fillRateLabels.products')}
          filled={data.products.filled}
          total={data.products.total}
          rate={data.products.fillRate}
        />
        <FillRateCard
          label={t('fillRateLabels.categories')}
          filled={data.categories.filled}
          total={data.categories.total}
          rate={data.categories.fillRate}
        />
      </div>

      {/* Recent products with meta */}
      {data.recentProducts.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('latestSeoFills')}
          </p>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {data.recentProducts.map(p => (
              <li key={p.id} className="px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeDate(p.updatedAt)}
                  </span>
                </div>
                {p.metaTitle && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{t('titleLabel')}</span>
                    <span className="text-xs">{p.metaTitle}</span>
                    <Button
                      variant="link"
                      size="sm"
                      className="ms-auto shrink-0"
                      type="button"
                      onClick={() => copy(p.metaTitle!, `title-${p.id}`)}
                    >
                      {copied === `title-${p.id}` ? t('copied') : t('copy')}
                    </Button>
                  </div>
                )}
                {p.metaDescription && (
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{t('descLabel')}</span>
                    <span className="text-xs">{p.metaDescription}</span>
                    <Button
                      variant="link"
                      size="sm"
                      className="ms-auto shrink-0"
                      type="button"
                      onClick={() => copy(p.metaDescription!, `desc-${p.id}`)}
                    >
                      {copied === `desc-${p.id}` ? t('copied') : t('copy')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href={`/stores/${storeId}/seo`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('openSeoPage')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function FaqPanel({ data, storeId }: { data: FaqResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-3">
      {/* Summary row */}
      <div className="flex items-center gap-4 text-sm">
        <span>
          <strong>{data.count}</strong>
          <span className="ms-1 text-muted-foreground">{t('faqUnit', { count: data.count })}</span>
        </span>
        {data.lastUpdated && (
          <span className="text-muted-foreground text-xs">
            {t('lastUpdated', { time: relativeDate(data.lastUpdated) })}
          </span>
        )}
      </div>

      {/* FAQ list */}
      {data.faqs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noFaqsYet')}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card text-sm">
          {data.faqs.map(f => (
            <li key={f.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{f.question}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  {f.aiDrafted && !f.manuallyEdited && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-ink">
                      {t('aiBadge')}
                    </span>
                  )}
                  {f.manuallyEdited && (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success-ink">
                      {t('editedBadge')}
                    </span>
                  )}
                </div>
              </div>
              {f.questionAr && (
                <p className="mt-0.5 text-xs text-muted-foreground" dir="rtl">
                  {f.questionAr}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {f.answerPreview}
                {f.answerPreview.length >= 150 ? '…' : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/stores/${storeId}/seo#faqs`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('viewFaqsOnSeoPage')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function HowtoPanel({ data, storeId }: { data: HowtoResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-3">
      {/* Summary row */}
      <div className="flex items-center gap-4 text-sm">
        <span>
          <strong>{data.count}</strong>
          <span className="ms-1 text-muted-foreground">
            {t('guideUnit', { count: data.count })}
          </span>
        </span>
        {data.lastUpdated && (
          <span className="text-xs text-muted-foreground">
            {t('lastUpdated', { time: relativeDate(data.lastUpdated) })}
          </span>
        )}
      </div>

      {/* HowTo list */}
      {data.howtos.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noHowtosYet')}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card text-sm">
          {data.howtos.map(h => (
            <li key={h.id} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{h.title}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {t('stepCount', { count: h.stepCount })}
                  </span>
                  {h.aiDrafted && !h.manuallyEdited && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-ink">
                      {t('aiBadge')}
                    </span>
                  )}
                  {h.manuallyEdited && (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success-ink">
                      {t('editedBadge')}
                    </span>
                  )}
                </div>
              </div>
              {h.titleAr && (
                <p className="mt-0.5 text-xs text-muted-foreground" dir="rtl">
                  {h.titleAr}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {h.descriptionPreview}
                {h.descriptionPreview.length >= 150 ? '…' : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/stores/${storeId}/seo#howtos`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('viewHowtosOnSeoPage')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function MetaAeoPanel({ data, storeId }: { data: MetaAeoResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-4">
      {/* Fill-rate cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FillRateCard
          label={t('fillRateLabels.store')}
          filled={data.storeAeoFilled ? 1 : 0}
          total={1}
          rate={data.storeAeoFilled ? 1 : 0}
        />
        <FillRateCard
          label={t('fillRateLabels.products')}
          filled={data.products.filled}
          total={data.products.total}
          rate={data.products.fillRate}
        />
        <FillRateCard
          label={t('fillRateLabels.categories')}
          filled={data.categories.filled}
          total={data.categories.total}
          rate={data.categories.fillRate}
        />
      </div>

      {/* Store-level AEO description if set */}
      {data.storeMetaDescriptionAeo && (
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <p className="mb-1 font-medium text-muted-foreground">{t('storeAeoDescriptionLabel')}</p>
          <p>{data.storeMetaDescriptionAeo}</p>
        </div>
      )}

      {/* Recent products */}
      {data.recentProducts.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('recentlyRewritten')}
          </p>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {data.recentProducts.map(p => (
              <li key={p.id} className="px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {relativeDate(p.updatedAt)}
                  </span>
                </div>
                {p.metaDescriptionAeo && (
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                    {p.metaDescriptionAeo}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href={`/stores/${storeId}/seo`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('openSeoPage')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function CategorizePanel({ data, storeId }: { data: CategorizeResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-4">
      <FillRateCard
        label={t('fillRateLabels.productsCategorized')}
        filled={data.products.filled}
        total={data.products.total}
        rate={data.products.fillRate}
      />

      {data.recentProducts.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('recentlyCategorized')}
          </p>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {data.recentProducts.map(p => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="font-medium">{p.name}</span>
                {p.categoryName && (
                  <span className="shrink-0 text-xs text-muted-foreground">{p.categoryName}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href={`/stores/${storeId}/products`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('openCatalogProducts')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function ImageAltPanel({ data, storeId }: { data: ImageAltResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-4">
      <FillRateCard
        label={t('fillRateLabels.imagesWithAlt')}
        filled={data.images.filled}
        total={data.images.total}
        rate={data.images.fillRate}
      />

      <Link
        href={`/stores/${storeId}/products`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('openCatalogProducts')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function ExcerptPanel({ data, storeId }: { data: ExcerptResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-4">
      <FillRateCard
        label={t('fillRateLabels.productsWithExcerpt')}
        filled={data.products.filled}
        total={data.products.total}
        rate={data.products.fillRate}
      />

      {data.recentProducts.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('recentlyFilled')}
          </p>
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {data.recentProducts.map(p => (
              <li key={p.id} className="px-3 py-2">
                <p className="font-medium">{p.name}</p>
                {p.excerpt && <p className="mt-0.5 text-xs text-muted-foreground">{p.excerpt}</p>}
                {p.excerptAr && (
                  <p className="mt-0.5 text-xs text-muted-foreground" dir="rtl">
                    {p.excerptAr}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href={`/stores/${storeId}/products`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('openCatalogProducts')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

function TagsPanel({ data, storeId }: { data: TagsResult; storeId: string }) {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FillRateCard
          label={t('fillRateLabels.productsTagged')}
          filled={data.products.filled}
          total={data.products.total}
          rate={data.products.fillRate}
        />
        <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-center">
          <div className="text-2xl font-bold text-foreground">{data.totalTags}</div>
          <div className="mt-1 text-xs font-medium text-foreground">{t('totalTags')}</div>
        </div>
      </div>

      <Link
        href={`/stores/${storeId}/products`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('openCatalogProducts')}
        <ArrowIcon />
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function CollapsiblePanel({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* Header — toggle */}
      <button
        data-ui="row"
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-medium text-sm text-foreground">{title}</span>
          {badge && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary-ink">
              {badge}
            </span>
          )}
        </div>
        <ChevronIcon open={open} />
      </button>

      {/* Body */}
      {open && <div className="border-t px-4 py-4">{children}</div>}
    </div>
  );
}

function FillRateCard({
  label,
  filled,
  total,
  rate,
}: {
  label: string;
  filled: number;
  total: number;
  rate: number;
}) {
  const percentage = pct(rate);
  const color =
    rate >= 0.8 ? 'text-success-ink' : rate >= 0.4 ? 'text-warning-ink' : 'text-destructive-ink';

  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-center">
      <div className={`text-2xl font-bold ${color}`}>{percentage}%</div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {filled}/{total}
      </div>
      <div className="mt-1 text-xs font-medium text-foreground">{label}</div>
      {/* Thin fill-rate bar */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full bg-primary transition-all" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function Loading() {
  const t = useT('aiTools.sweepResults');
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      <SpinIcon className="h-4 w-4 animate-spin" />
      {t('loading')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline SVG icons (no external dep)
// ---------------------------------------------------------------------------

function SpinIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'h-4 w-4'} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? 'h-4 w-4'}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ArrowIcon() {
  return <span aria-hidden>→</span>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function pct(rate: number) {
  return Math.round(rate * 100);
}

function relativeDate(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
