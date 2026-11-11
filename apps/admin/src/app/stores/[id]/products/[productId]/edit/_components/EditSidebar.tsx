'use client';

import { Input, Select } from '@ebda/ui';
import { PRODUCT_BADGE_LABEL_MAX_LENGTH } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { AICategorySuggestions } from '../../../../../../../components/AICategorySuggestions';

interface Option {
  value: string;
  label: string;
}

interface EditSidebarProps {
  status: string;
  onStatusChange: (value: string) => void;
  statuses: Option[];
  category: string;
  onCategoryChange: (value: string) => void;
  categoryOptions: Option[];
  isFeatured: boolean;
  onFeaturedChange: (value: boolean) => void;
  isNew: boolean;
  onIsNewChange: (value: boolean) => void;
  isBestSeller: boolean;
  onIsBestSellerChange: (value: boolean) => void;
  /**
   * Merchant-authored product card badge, bilingual. Lives with the other
   * card-facing flags because it IS one — the difference is that Featured /
   * New / Best Seller are booleans the platform styles, and this one carries
   * the merchant's own words.
   */
  badgeLabel: string;
  onBadgeLabelChange: (value: string) => void;
  badgeLabelAr: string;
  onBadgeLabelArChange: (value: string) => void;
  /** Tenant scope for AI calls. */
  storeId: string;
  /** Product name + description, fed to category-suggest endpoint. */
  productName: string;
  productDescription: string;
}

export function EditSidebar({
  status,
  onStatusChange,
  statuses,
  category,
  onCategoryChange,
  categoryOptions,
  isFeatured,
  onFeaturedChange,
  isNew,
  onIsNewChange,
  isBestSeller,
  onIsBestSellerChange,
  badgeLabel,
  onBadgeLabelChange,
  badgeLabelAr,
  onBadgeLabelArChange,
  storeId,
  productName,
  productDescription,
}: EditSidebarProps) {
  const tSections = useT('products.edit.sections');
  const tFields = useT('products.edit.fields');

  return (
    <div className="space-y-6">
      <div className="rounded-md border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('status')}</h2>
        <Select
          label={tFields('productStatus')}
          value={status}
          onChange={e => onStatusChange(e.target.value)}
          options={statuses}
        />
      </div>

      <div className="rounded-md border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('organization')}</h2>
        <Select
          label={tFields('category')}
          value={category}
          onChange={e => onCategoryChange(e.target.value)}
          options={categoryOptions}
        />
        <AICategorySuggestions
          storeId={storeId}
          productName={productName}
          productDescription={productDescription}
          hasSelection={!!category}
          onSelect={onCategoryChange}
        />
      </div>

      <div className="rounded-md border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('flags')}</h2>
        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={e => onFeaturedChange(e.target.checked)}
              className="h-4 w-4 rounded-md border-border text-primary focus:ring-primary"
            />
            <span className="text-sm text-foreground">{tFields('featured')}</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isNew}
              onChange={e => onIsNewChange(e.target.checked)}
              className="h-4 w-4 rounded-md border-border text-primary focus:ring-primary"
            />
            <span className="text-sm text-foreground">{tFields('newArrival')}</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isBestSeller}
              onChange={e => onIsBestSellerChange(e.target.checked)}
              className="h-4 w-4 rounded-md border-border text-primary focus:ring-primary"
            />
            <span className="text-sm text-foreground">{tFields('bestSeller')}</span>
          </label>
        </div>
        {/* Custom card badge — free text, bilingual. Sits with the card flags
            above because it renders in the same place on the card. Empty =
            no badge at all (that is the feature's off switch: there is no
            separate toggle by design). */}
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <Input
            label={tFields('badgeLabel')}
            value={badgeLabel}
            onChange={e => onBadgeLabelChange(e.target.value)}
            placeholder={tFields('badgeLabelPlaceholder')}
            maxLength={PRODUCT_BADGE_LABEL_MAX_LENGTH}
          />
          <Input
            label={tFields('badgeLabelAr')}
            value={badgeLabelAr}
            onChange={e => onBadgeLabelArChange(e.target.value)}
            placeholder={tFields('badgeLabelArPlaceholder')}
            maxLength={PRODUCT_BADGE_LABEL_MAX_LENGTH}
            lang="ar"
            dir="rtl"
          />
          <p className="text-xs text-muted-foreground">{tFields('badgeLabelHint')}</p>
        </div>
      </div>
    </div>
  );
}
