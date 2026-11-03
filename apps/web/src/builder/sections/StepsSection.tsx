'use client';

/**
 * `steps` (Phase B3, Jasmine Clinic; Ruling B3-6, document-only): the routine as an ORDERED list.
 * Each `step` block is a name, one line, and (optionally) a product BY REFERENCE (`productIds[0]`).
 *
 * Honesty rules, each pinned by tests/unit/jasmine-variants-render.test.tsx:
 * - the list is an `<ol>` and carries numbers because ORDER matters (cleanse, then treat, then
 *   protect); fewer than 2 steps is not a routine and renders nothing;
 * - products resolve against the store's own pool (store-scoped fetch), so an unknown or foreign id
 *   is simply absent and the step shows without a product (C11);
 * - "Add all" exists only when EVERY step has a product that is buyable right now and has no
 *   options to pick (a variant product routes to its page instead, the `canBuyNow` rule). It adds
 *   the real products through the cart's own path, or the real bundle when one holds exactly these
 *   products (then the saving is the bundle's, fetched live, never a number written in the page);
 * - a step ticks when its product is already in the cart, or when the routine's exact bundle is (the
 *   Clinic playful detail; the tick is a static CSS state keyed on data-done, globals.css).
 */
import React, { useEffect, useMemo, useState } from 'react';
import Link from '../../components/StoreLink';
import {
  sanitizeUrl,
  type BlockNode,
  type SectionPaddingMaxWidthVisibility,
  type StoreLayoutSettings,
} from '@ebda/shared';
import { api, type Product, type BundleSavingInfo } from '../../lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useCart } from '../../contexts/CartContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { toTemplateProduct, needsOptions } from '../../templates/adapters';
import { getProductPricing } from '../../lib/product-pricing';
import { canBuyNow } from '../../lib/can-buy-now';
import { bundlesNavVisible } from '../../lib/bundles-nav';
import { pickLocalizedName } from '../../templates/shared/display-helpers';
import { soldOutLabel } from '../../templates/shared/ProductCardCta';
import { resolveProductCardCtaOosDefaults } from '../../templates/shared/product-card-defaults';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { EmptySectionHint } from '../render/EmptySectionHint';
import { SectionHeader } from './SectionHeader';

export interface StepsSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  subheading?: string;
  subheadingAr?: string;
  buttonText?: string;
  buttonTextAr?: string;
  bgColor?: string;
}

const MIN_STEPS = 2;
const MAX_STEPS = 5;

export function StepsSection({
  settings,
  blocks,
  products,
  editorMode = false,
  showPrice = true,
  cardLayout,
}: {
  settings: StepsSettings;
  blocks: BlockNode[];
  /** The store's own product pool (store-scoped fetch). */
  products: Product[];
  editorMode?: boolean;
  /** The store's effective card-price switch (`showPriceOnCards` x `showCardPrice`). */
  showPrice?: boolean;
  cardLayout?: StoreLayoutSettings | null;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const formatPrice = useLocalePrice();
  const { items, bundles, addItem, addBundle } = useCart();
  const ar = language === 'ar';
  const oos = resolveProductCardCtaOosDefaults(cardLayout);
  const pick = (en?: unknown, a?: unknown) =>
    ((ar ? (a as string) || (en as string) : (en as string) || (a as string)) ?? '').trim();
  const spacing = sectionSpacingClasses(settings, store.look);
  const byId = new Map(products.map(p => [p.id, p]));
  const inCart = new Set(items.map(i => i.productId));

  const steps = blocks
    .filter(b => b.type === 'step' && b.hidden !== true)
    .slice(0, MAX_STEPS)
    .map(b => {
      const ids = Array.isArray(b.settings.productIds) ? b.settings.productIds : [];
      const product = typeof ids[0] === 'string' ? byId.get(ids[0]) : undefined;
      const link = typeof b.settings.link === 'string' ? b.settings.link.trim() : '';
      return {
        id: b.id,
        title: pick(b.settings.title, b.settings.titleAr),
        body: pick(b.settings.body, b.settings.bodyAr),
        link,
        product,
      };
    })
    .filter(s => s.title || s.body);

  // "Add all": every step holds a product that is buyable now with no option to pick.
  const allBuyable =
    steps.length >= MIN_STEPS &&
    steps.every(s => s.product && canBuyNow(s.product) && !needsOptions(s.product));
  const productIds = useMemo(
    () => (allBuyable ? steps.map(s => s.product!.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allBuyable, steps.map(s => s.product?.id).join(',')]
  );

  // The bundle that holds exactly these products, if any: its saving is live (NEVER-stale price).
  const [bundle, setBundle] = useState<BundleSavingInfo | null>(null);
  const bundlesOn = bundlesNavVisible(store.enabledFeatures);
  useEffect(() => {
    if (!allBuyable || !bundlesOn || !store.id || store.id === 'demo') {
      setBundle(null);
      return;
    }
    let live = true;
    api
      .getBundleSavings(store.id, productIds)
      .then(res => {
        if (!live) return;
        const exact = res.success ? res.data?.savings?.find(s => s.exact) : undefined;
        setBundle(exact ?? null);
      })
      .catch(() => {
        if (live) setBundle(null);
      });
    return () => {
      live = false;
    };
  }, [allBuyable, bundlesOn, store.id, productIds]);

  const [adding, setAdding] = useState(false);
  // The routine added as its bundle puts all three products in the cart as ONE bundle row, so the
  // steps tick when that exact bundle is there (a loose add ticks each step on its own).
  const bundleInCart = !!bundle && bundles.some(b => b.bundleId === bundle.bundleId);

  if (steps.length < MIN_STEPS) return editorMode ? <EmptySectionHint kind="steps" /> : null;

  const priced = steps.map(s => {
    if (!s.product) return null;
    const pricing = getProductPricing(toTemplateProduct(s.product), undefined, 'card');
    return { pricing };
  });
  const sum = allBuyable ? priced.reduce((n, p) => n + (p?.pricing.displayPrice ?? 0), 0) : 0;

  async function addAll() {
    if (!allBuyable || adding) return;
    setAdding(true);
    try {
      if (bundle) {
        await addBundle(bundle.bundleId, 1);
      } else {
        // Sequential awaits so each addItem sees the post-previous-add cart state.
        for (const s of steps) {
          const p = s.product!;
          await addItem({
            id: p.id,
            name: p.name,
            nameAr: p.nameAr,
            price: p.price,
            slug: p.slug,
            image: p.images?.[0]?.url,
          });
        }
      }
    } finally {
      setAdding(false);
    }
  }

  const savingLine = bundle
    ? t(
        'Save {n}% when you buy them together',
        translations['Save {n}% when you buy them together']
      ).replace('{n}', String(bundle.percent))
    : '';
  const buttonText =
    pick(settings.buttonText, settings.buttonTextAr) ||
    t('Add all to cart', translations['Add all to cart']);

  return (
    <section
      data-section="steps"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        <SectionHeader
          title={pick(settings.heading, settings.headingAr)}
          subtitle={pick(settings.subheading, settings.subheadingAr)}
          editTitle={
            editorMode ? { 'data-builder-setting': ar ? 'headingAr' : 'heading' } : undefined
          }
          editSubtitle={
            editorMode ? { 'data-builder-setting': ar ? 'subheadingAr' : 'subheading' } : undefined
          }
        />
        <ol role="list" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s, i) => {
            const done = bundleInCart || (!!s.product && inCart.has(s.product.id));
            const price = priced[i]?.pricing;
            const name = s.product ? (pickLocalizedName(s.product, ar) ?? s.product.name) : '';
            return (
              <li
                key={s.id}
                {...(editorMode ? { 'data-builder-block': s.id } : undefined)}
                data-part="step"
                data-done={done ? 'true' : 'false'}
                className="flex gap-3 rounded-[var(--radius)] border border-border bg-card p-4"
              >
                <span
                  className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
                  aria-hidden="true"
                >
                  <span data-part="step-num">{i + 1}</span>
                  <svg
                    data-part="step-tick"
                    viewBox="0 0 16 16"
                    className="absolute inset-0 m-auto h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-base font-semibold text-foreground">
                    {editorMode ? (
                      <span data-builder-setting={ar ? 'titleAr' : 'title'}>{s.title}</span>
                    ) : (
                      s.title
                    )}
                    {done && (
                      <span className="sr-only">
                        {' '}
                        — {t('In your cart', translations['In your cart'])}
                      </span>
                    )}
                  </h3>
                  {s.body && (
                    <p
                      className="mt-1 text-sm text-muted-foreground"
                      {...(editorMode
                        ? { 'data-builder-setting': ar ? 'bodyAr' : 'body' }
                        : undefined)}
                    >
                      {s.body}
                    </p>
                  )}
                  {s.product && !canBuyNow(s.product) && oos.resolvedOosLabel !== false && (
                    <p className="mt-1 text-xs font-medium text-muted-foreground">
                      {soldOutLabel(ar, oos.resolvedOosLabelTextEn, oos.resolvedOosLabelTextAr)}
                    </p>
                  )}
                  {s.product ? (
                    <Link
                      href={storeUrl(`/products/${s.product.slug}`)}
                      className="group/row mt-2 flex min-h-[44px] items-center justify-between gap-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {/* PREMIUM-35: a product row is a card, not a text link: no underline across name and price */}
                      <span className="min-w-0 line-clamp-2 transition-colors group-hover/row:text-primary">
                        {name}
                      </span>
                      {showPrice && price && (
                        <span className="flex shrink-0 flex-col items-end whitespace-nowrap text-end font-medium">
                          <span>
                            {price.mode === 'fromMin' ? `${t('From', 'من')} ` : ''}
                            {formatPrice(price.displayPrice)}
                          </span>
                          {price.displayCompare !== null && (
                            <s className="text-xs font-normal text-muted-foreground">
                              {formatPrice(price.displayCompare)}
                            </s>
                          )}
                        </span>
                      )}
                    </Link>
                  ) : (
                    s.link && (
                      <Link
                        href={storeUrl(sanitizeUrl(s.link, '/products'))}
                        className="mt-2 inline-flex min-h-[44px] items-center text-sm text-foreground underline decoration-primary underline-offset-4 hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t('Shop', translations['Shop'])}
                      </Link>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {allBuyable && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={addAll}
              disabled={adding}
              {...(editorMode
                ? { 'data-builder-setting': ar ? 'buttonTextAr' : 'buttonText' }
                : undefined)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-[var(--radius)] bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
            >
              {buttonText}
            </button>
            {showPrice && (
              <span className="text-sm text-foreground" data-part="steps-total">
                {formatPrice(bundle ? bundle.price : sum)}
                {bundle && (
                  <s className="ms-2 text-muted-foreground">
                    <span className="sr-only">{t('Instead of', translations['Instead of'])} </span>
                    {formatPrice(bundle.componentSum)}
                  </s>
                )}
              </span>
            )}
            {showPrice && bundle && (
              <span className="text-sm font-medium text-foreground">{savingLine}</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
