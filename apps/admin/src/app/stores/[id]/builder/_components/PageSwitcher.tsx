'use client';

/**
 * Which page the editor edits: the home page, a product page, the collection page or the cart
 * (Ruling VE-3 amended). A native select, so it is keyboard and screen-reader friendly and works on a
 * phone. The product page is previewed with one of the store's own products, chosen next to it.
 */
import { PAGE_KINDS, PAGE_KIND_LABELS, type PageKind } from '@ebda/shared';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { FIELD_CLASSES } from '@/components/ui/tokens';

export interface PreviewProduct {
  slug: string;
  name: string;
  nameAr?: string | null;
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
  return (
    <div className="flex items-center gap-1">
      <select
        aria-label={t('label')}
        value={pageKey}
        onChange={e => onChange(e.target.value as PageKind)}
        className={FIELD_CLASSES}
        data-testid="page-switcher"
        data-setting-id="builder.page-switcher"
      >
        {PAGE_KINDS.map(k => (
          <option key={k} value={k}>
            {locale === 'ar' ? PAGE_KIND_LABELS[k].ar : PAGE_KIND_LABELS[k].en}
          </option>
        ))}
      </select>
      {pageKey === 'product' &&
        (products.length > 0 ? (
          <select
            aria-label={t('previewProduct')}
            value={previewSlug ?? ''}
            onChange={e => onPreviewSlug(e.target.value)}
            className={`${FIELD_CLASSES} max-w-40 truncate`}
            data-testid="preview-product"
          >
            {products.map(p => (
              <option key={p.slug} value={p.slug}>
                {locale === 'ar' && p.nameAr ? p.nameAr : p.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-muted-foreground" data-testid="no-preview-product">
            {t('noProducts')}
          </span>
        ))}
    </div>
  );
}
