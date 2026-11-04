'use client';

import React from 'react';
import { useLanguage, translations } from '../../contexts/LanguageContext';

/**
 * Editor canvas only (`PageRenderer` passes `editorMode`). A data-driven
 * section with nothing to show renders NOTHING on the public storefront, so
 * the merchant would otherwise see no trace of it in the canvas and could not
 * select it. This dashed placeholder keeps the section visible and selectable
 * in the editor and says what fills it. Never rendered on a public page.
 */
export type EmptySectionKind =
  | 'categories'
  | 'newArrivals'
  | 'bestSellers'
  | 'brandStory'
  | 'blogCarousel'
  | 'trustStrip'
  | 'testimonials'
  | 'shopTheLook'
  | 'steps'
  | 'makerProfile'
  | 'giftFinder';

const HINT_KEY: Record<EmptySectionKind, keyof typeof translations> = {
  categories: 'Add categories and they will appear here.',
  newArrivals: 'Add products and your newest ones will appear here.',
  bestSellers: 'Best sellers appear here once your products start selling.',
  brandStory: 'Add a store description or image in store settings to show your story here.',
  blogCarousel: 'Publish a blog post to show it here.',
  trustStrip: 'Write your own trust items (delivery, payment, returns) and they will show here.',
  testimonials: 'Customer reviews appear here once customers leave them.',
  shopTheLook: 'Add a look with a photo and its pieces and it will appear here.',
  steps: 'Add at least two steps and your routine will appear here.',
  makerProfile: 'Add a name or a photo and your kitchen profile will appear here.',
  giftFinder: 'Add an occasion or a budget and your gift finder will appear here.',
};

/** The admin page that fills a data-driven section, when there is one. */
const FILL_TARGET: Partial<Record<EmptySectionKind, 'products' | 'categories'>> = {
  categories: 'categories',
  newArrivals: 'products',
  bestSellers: 'products',
};
const FILL_LABEL = {
  products: 'Add products',
  categories: 'Add categories',
} as const;

/**
 * Editor canvas only. A hero whose slides all lack a picture draws nothing on the storefront (the
 * slider skips a slide without an image), so the canvas shows this instead of an empty slide.
 * `blockId` is the first slide, so a click selects it and its image field is one step away.
 */
export function EmptyHeroSlideHint({ blockId }: { blockId?: string }) {
  const { t } = useLanguage();
  const msg = 'Add a picture to this slide' as const;
  return (
    <div
      data-empty-section="hero"
      data-builder-block={blockId}
      className="flex aspect-[4/3] w-full items-center justify-center border border-dashed border-border bg-muted px-4 text-center text-sm text-muted-foreground sm:aspect-[1920/700]"
    >
      <p>{t(msg, translations[msg])}</p>
    </div>
  );
}

export function EmptySectionHint({ kind }: { kind: EmptySectionKind }) {
  const { t } = useLanguage();
  const key = HINT_KEY[kind];
  const note: keyof typeof translations =
    'Only you see this in the editor. Visitors do not see an empty section.';
  return (
    <div
      data-empty-section={kind}
      className="mx-auto my-6 max-w-7xl rounded-[var(--radius)] border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground sm:px-6 lg:px-8"
    >
      <p>{t(key, translations[key])}</p>
      <p className="mt-1 text-xs">{t(note, translations[note])}</p>
      {FILL_TARGET[kind] && (
        // The canvas intercepts this click and asks the admin to open the page (protocol `open-admin`).
        <button
          type="button"
          data-builder-action="open-admin"
          data-builder-target={FILL_TARGET[kind]}
          className="mt-3 inline-flex min-h-11 items-center rounded-[var(--radius)] border border-input px-4 text-sm font-medium text-foreground hover:bg-muted"
        >
          {t(FILL_LABEL[FILL_TARGET[kind]!], translations[FILL_LABEL[FILL_TARGET[kind]!]])}
        </button>
      )}
    </div>
  );
}
