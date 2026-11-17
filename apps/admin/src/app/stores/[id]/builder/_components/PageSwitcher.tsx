'use client';

/**
 * Which page the editor edits: the home page, a product page, the collection page or the cart
 * (Ruling VE-3 amended). Both pickers are 32px menu buttons with a chevron (editor premium F39):
 * the page menu shows an icon and the page name; the product page is previewed with one of the
 * store's own products, chosen in a searchable combobox with the product picture.
 */
import { PAGE_KINDS, PAGE_KIND_LABELS, type PageKind } from '@ebda/shared';
import { useLocale } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, Home, LayoutGrid, Package, Search, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { HeaderPopover } from './HeaderPopover';

export interface PreviewProduct {
  slug: string;
  name: string;
  nameAr?: string | null;
  /** The product pictures when the list endpoint returns them. */
  images?: { url: string }[];
}

const PAGE_ICON: Record<PageKind, ReactNode> = {
  home: <Home className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
  product: <Package className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
  collection: <LayoutGrid className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
  cart: <ShoppingCart className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
};

const chevron = (
  <ChevronDown className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
);

/** Up / Down / Home / End move focus between the items of a menu or listbox. */
function arrowKeys(e: React.KeyboardEvent<HTMLElement>, selector: string) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  const at = items.indexOf(document.activeElement as HTMLElement);
  let to = -1;
  if (e.key === 'ArrowDown') to = at + 1;
  else if (e.key === 'ArrowUp') to = at - 1;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = items.length - 1;
  else return;
  e.preventDefault();
  items[(to + items.length) % items.length]?.focus();
}

export function PageSwitcher({
  pageKey,
  onChange,
  products,
  previewSlug,
  onPreviewSlug,
}: {
  pageKey: PageKind;
  onChange: (next: PageKind) => void;
  products: PreviewProduct[];
  previewSlug: string | null;
  onPreviewSlug: (slug: string) => void;
}) {
  const t = useT('builder.pages');
  const locale = useLocale();
  const ar = locale === 'ar';
  const pageName = (k: PageKind) => (ar ? PAGE_KIND_LABELS[k].ar : PAGE_KIND_LABELS[k].en);
  const productName = (p: PreviewProduct) => (ar && p.nameAr ? p.nameAr : p.name);
  const [query, setQuery] = useState('');
  const chosen = products.find(p => p.slug === previewSlug) ?? null;
  const shown = products.filter(p => {
    const q = query.trim().toLowerCase();
    return !q || `${p.name} ${p.nameAr ?? ''}`.toLowerCase().includes(q);
  });

  return (
    <div className="flex items-center gap-1">
      <HeaderPopover
        haspopup="menu"
        panelRole="menu"
        panelLabel={t('label')}
        trigger={({ triggerProps }) => (
          <Button
            {...triggerProps}
            variant="outline"
            size="sm"
            type="button"
            aria-label={`${t('label')}: ${pageName(pageKey)}`}
            className="max-w-44 gap-1.5 font-semibold"
            data-testid="page-switcher"
            data-setting-id="builder.page-switcher"
            data-value={pageKey}
          >
            {PAGE_ICON[pageKey]}
            <span className="truncate">{pageName(pageKey)}</span>
            {chevron}
          </Button>
        )}
      >
        {({ close }) => (
          <div onKeyDown={e => arrowKeys(e, '[role="menuitemradio"]')}>
            {PAGE_KINDS.map(k => (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={k === pageKey}
                autoFocus={k === pageKey}
                onClick={() => {
                  close();
                  if (k !== pageKey) onChange(k);
                }}
                className="flex min-h-8 w-full items-center gap-2 px-3 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                data-testid={`page-option-${k}`}
              >
                <span className="shrink-0 text-muted-foreground">{PAGE_ICON[k]}</span>
                <span className="flex-1 truncate">{pageName(k)}</span>
                {k === pageKey && (
                  <Check
                    className="h-4 w-4 text-primary-ink"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </HeaderPopover>
      {pageKey === 'product' &&
        (products.length > 0 ? (
          <HeaderPopover
            haspopup="listbox"
            panelClassName="w-64"
            trigger={({ triggerProps }) => (
              <Button
                {...triggerProps}
                variant="outline"
                size="sm"
                type="button"
                aria-label={`${t('previewProduct')}: ${chosen ? productName(chosen) : ''}`}
                className="max-w-48 gap-1.5"
                data-testid="preview-product"
                data-value={previewSlug ?? ''}
              >
                {chosen?.images?.[0]?.url ? (
                  <img
                    src={chosen.images[0].url}
                    alt=""
                    width={20}
                    height={20}
                    className="h-5 w-5 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <Package className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="truncate">
                  {chosen ? productName(chosen) : t('previewProduct')}
                </span>
                {chevron}
              </Button>
            )}
          >
            {({ close }) => (
              <div>
                <div className="relative px-2 pb-1">
                  <Search
                    className="pointer-events-none absolute start-4 top-2 h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="preview-product-list"
                    aria-label={t('searchProduct')}
                    placeholder={t('searchProduct')}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        e.currentTarget
                          .closest('[data-popover-panel]')
                          ?.querySelector<HTMLElement>('[role="option"]')
                          ?.focus();
                      }
                    }}
                    autoFocus
                    className="h-8 w-full rounded-md border border-input bg-background ps-8 pe-2 text-sm"
                    data-testid="preview-product-search"
                  />
                </div>
                <div
                  id="preview-product-list"
                  role="listbox"
                  aria-label={t('previewProduct')}
                  onKeyDown={e => arrowKeys(e, '[role="option"]')}
                  className="max-h-64 overflow-y-auto"
                >
                  {shown.length === 0 && (
                    <p className="px-3 py-2 text-sm text-muted-foreground">{t('noMatch')}</p>
                  )}
                  {shown.map(p => (
                    <button
                      key={p.slug}
                      type="button"
                      role="option"
                      aria-selected={p.slug === previewSlug}
                      onClick={() => {
                        close();
                        setQuery('');
                        onPreviewSlug(p.slug);
                      }}
                      className="flex min-h-8 w-full items-center gap-2 px-3 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                    >
                      {p.images?.[0]?.url ? (
                        <img
                          src={p.images[0].url}
                          alt=""
                          width={24}
                          height={24}
                          className="h-6 w-6 shrink-0 rounded-md object-cover"
                        />
                      ) : (
                        <Package
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="flex-1 truncate">{productName(p)}</span>
                      {p.slug === previewSlug && (
                        <Check
                          className="h-4 w-4 text-primary-ink"
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </HeaderPopover>
        ) : (
          <span className="text-xs text-muted-foreground" data-testid="no-preview-product">
            {t('noProducts')}
          </span>
        ))}
    </div>
  );
}
