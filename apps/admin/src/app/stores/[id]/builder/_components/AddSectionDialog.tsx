'use client';

/**
 * "Add section" picker: every registry type allowed in the chosen group, one card per PRESET with
 * a wireframe drawn in the store's own colours and corner radius, the bilingual name, a search
 * field (`/` focuses it) and category chips (the last one is remembered). A type at its
 * cardinality cap shows a "Max N reached" chip and a "Show existing" action that selects the
 * section already on the page. Inserting goes through the reducer, which owns the invariants.
 */
import { Button } from '@/components/ui/Button';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useLocale } from 'next-intl';
import {
  SECTION_REGISTRY,
  sectionAllowedOnPage,
  type PageDefinition,
  type SectionList,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { flowOrder, orderByFlow } from '../../../../../lib/builder-flow-order';
import { SectionThumb } from './SectionThumb';
import { useRestoreFocus } from '../_lib/use-restore-focus';

interface Props {
  list: SectionList;
  doc: PageDefinition;
  /** The store's template and look: its own section types are listed first, in storefront order. */
  template?: string | null;
  look?: string | null;
  /** The store's theme tokens (colours, corner radius): the thumbnails are drawn with them. */
  theme?: object;
  onPick: (sectionType: string, presetIndex: number) => void;
  /** "Show existing": select the section of that id already on the page (the caller closes the picker). */
  onShowExisting?: (sectionId: string) => void;
  onClose: () => void;
}

type Category = 'hero' | 'products' | 'story' | 'trust' | 'header' | 'footer' | 'other';
const CATEGORY_ORDER: Category[] = [
  'hero',
  'products',
  'story',
  'trust',
  'header',
  'footer',
  'other',
];
/** Which section types sit under which chip. An unlisted type lands under More, never disappears. */
const TYPES_OF: Record<Category, string[]> = {
  hero: ['hero', 'editorial-collage', 'piece-window'],
  products: [
    'new-arrivals',
    'best-sellers',
    'product-carousel',
    'featured-collection',
    'collection-list',
    'category-grid',
    'product-spotlight',
    'shop-the-look',
    'gift-finder',
  ],
  story: [
    'brand-story',
    'image-text',
    'maker-profile',
    'key-ingredients',
    'kitchen-days',
    'spec-sheet',
    'steps',
    'blog-carousel',
  ],
  trust: ['trust-strip', 'trust-badges', 'testimonials'],
  header: ['announcement', 'header'],
  footer: ['footer', 'newsletter'],
  other: [],
};
const categoryOf = (type: string): Category =>
  CATEGORY_ORDER.find(c => TYPES_OF[c].includes(type)) ?? 'other';
const LAST_CATEGORY_KEY = 'ebda.builder.addSection.category';

function readLastCategory(): string {
  try {
    return window.localStorage.getItem(LAST_CATEGORY_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

export function AddSectionDialog({
  list,
  doc,
  template,
  look,
  theme,
  onPick,
  onShowExisting,
  onClose,
}: Props) {
  const t = useT('builder.addSection');
  const locale = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [entered, setEntered] = useState(false);
  useRestoreFocus();
  useEffect(() => {
    ref.current?.showModal();
    searchRef.current?.focus();
    setCategory(readLastCategory());
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const pickCategory = (c: string) => {
    setCategory(c);
    try {
      window.localStorage.setItem(LAST_CATEGORY_KEY, c);
    } catch {
      /* private mode / blocked storage: the chip still works for this session */
    }
  };
  const count = (type: string) =>
    [...doc.sectionGroups.header, ...doc.sections, ...doc.sectionGroups.footer].filter(
      n => n.type === type
    ).length;
  // only what belongs on this page (a cart has no hero; a product page has reviews)
  const allowed = SECTION_REGISTRY.filter(
    d => d.group === list && sectionAllowedOnPage(d, doc.pageKey)
  );
  // The home page's template group: what this store's look is made of first (as the storefront draws it),
  // then everything else under one heading. Other groups and pages keep the registry order.
  const byFlow = list === 'template' && doc.pageKey === 'home';
  const split = byFlow
    ? orderByFlow(
        allowed.map(d => d.type),
        flowOrder(template, look)
      )
    : { first: allowed.map(d => d.type), more: [] as string[] };
  const defOf = (type: string) => allowed.find(d => d.type === type)!;
  const rows = [...split.first, ...split.more].map(defOf);
  const chips = useMemo(
    () => CATEGORY_ORDER.filter(c => allowed.some(d => categoryOf(d.type) === c)),
    [allowed]
  );
  // a remembered chip this group does not have falls back to "All"
  const activeCategory = chips.includes(category as Category) ? category : 'all';
  const q = query.trim().toLowerCase();
  const matches = (d: (typeof rows)[number], p: (typeof rows)[number]['presets'][number]) =>
    (activeCategory === 'all' || categoryOf(d.type) === activeCategory) &&
    (!q ||
      [p.nameEn, p.nameAr, d.labelEn, d.labelAr, d.type].some(v => v.toLowerCase().includes(q)));
  const filtering = activeCategory !== 'all' || q !== '';
  const existingId = (type: string) =>
    [...doc.sectionGroups.header, ...doc.sections, ...doc.sectionGroups.footer].find(
      n => n.type === type
    )?.id;
  let shown = 0;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="add-section-title"
      onKeyDown={e => {
        const el = e.target as HTMLElement;
        if (e.key === '/' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
          e.preventDefault();
          searchRef.current?.focus();
        }
      }}
      className={`w-[min(56rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/60 transition-[opacity,transform] duration-200 ease-out motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none ${
        entered ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
      data-testid="add-section-dialog"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 id="add-section-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <Button variant="ghost" size="sm" type="button" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      <div className="space-y-2 border-b border-border px-5 py-3">
        <label className="relative block">
          <span className="sr-only">{t('search')}</span>
          <Search
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-border bg-background ps-9 pe-3 text-sm"
            data-testid="add-section-search"
          />
        </label>
        {chips.length > 1 && (
          <div role="group" aria-label={t('categoryLabel')} className="flex flex-wrap gap-1.5">
            {['all', ...chips].map(c => (
              <Button
                key={c}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={activeCategory === c}
                onClick={() => pickCategory(c)}
                data-testid={`add-section-chip-${c}`}
                className={`${
                  activeCategory === c
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'text-muted-foreground'
                }`}
              >
                {c === 'all' ? t('all') : t(`categories.${c}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
      <ul className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.flatMap(d => {
          const tiles = d.presets.map((p, i) => ({ p, i })).filter(({ p }) => matches(d, p));
          shown += tiles.length;
          return [
            ...(!filtering &&
            split.more.length > 0 &&
            d.type === split.more[0] &&
            split.first.length > 0
              ? [
                  <li
                    key="more"
                    className="col-span-full pt-2 text-xs font-semibold text-muted-foreground"
                    data-testid="add-section-more"
                  >
                    {t('more')}
                  </li>,
                ]
              : []),
            ...tiles.map(({ p, i }) => {
              const full = count(d.type) >= d.maxCount;
              const name = locale === 'ar' ? p.nameAr : p.nameEn;
              const existing = full ? existingId(d.type) : undefined;
              return (
                <li key={`${d.type}-${i}`} className="flex flex-col gap-1">
                  <button
                    data-ui="tile"
                    type="button"
                    disabled={full}
                    onClick={() => onPick(d.type, i)}
                    className="relative w-full rounded-lg border border-border bg-background p-3 text-start hover:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                    data-testid={`preset-${d.type}-${i}`}
                  >
                    <SectionThumb type={d.type} settings={p.settings} theme={theme} />
                    <span className="mt-2 block text-sm font-medium">{name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {locale === 'ar' ? d.labelAr : d.labelEn}
                    </span>
                    {full && (
                      <span
                        data-testid={`max-chip-${d.type}-${i}`}
                        className="mt-1.5 inline-flex rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground"
                      >
                        {t('maxReached', { max: d.maxCount })}
                      </span>
                    )}
                  </button>
                  {full && existing && onShowExisting && (
                    <Button
                      variant="link"
                      size="sm"
                      type="button"
                      onClick={() => onShowExisting(existing)}
                      className="self-start"
                      data-testid={`show-existing-${d.type}-${i}`}
                    >
                      {t('showExisting')}
                    </Button>
                  )}
                </li>
              );
            }),
          ];
        })}
        {shown === 0 && (
          <li
            className="col-span-full py-8 text-center text-sm text-muted-foreground"
            data-testid="add-section-empty"
          >
            {t('noResults')}
          </li>
        )}
      </ul>
    </dialog>
  );
}
