'use client';

import { forwardRef, useState, useCallback } from 'react';
import { cn } from '../utils/cn';

export interface FilterOption {
  id: string;
  label: string;
  labelAr?: string;
  count?: number;
}

export interface PriceRange {
  min: number;
  max: number;
}

export interface ColorOption extends FilterOption {
  color: string;
}

export interface FilterSection {
  id: string;
  title: string;
  titleAr?: string;
  type: 'checkbox' | 'radio' | 'color' | 'price' | 'size';
  options?: FilterOption[];
  colorOptions?: ColorOption[];
  priceRange?: PriceRange;
  isExpanded?: boolean;
}

export interface ActiveFilters {
  categories?: string[];
  brands?: string[];
  colors?: string[];
  sizes?: string[];
  priceRange?: PriceRange;
  inStock?: boolean;
  onSale?: boolean;
  [key: string]: string[] | PriceRange | boolean | undefined;
}

export interface ProductFiltersProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Filter sections configuration */
  sections: FilterSection[];
  /** Currently active filters */
  activeFilters: ActiveFilters;
  /** Callback when filters change */
  onFiltersChange: (filters: ActiveFilters) => void;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Currency for price display */
  currency?: string;
  /** Show clear all button */
  showClearAll?: boolean;
  /** Collapsible sections */
  collapsible?: boolean;
  /** Custom labels */
  labels?: Partial<{
    clearAll: string;
    apply: string;
    priceFrom: string;
    priceTo: string;
    inStock: string;
    onSale: string;
  }>;
}

const defaultLabels = {
  en: {
    clearAll: 'Clear All',
    apply: 'Apply',
    priceFrom: 'From',
    priceTo: 'To',
    inStock: 'In Stock Only',
    onSale: 'On Sale',
  },
  ar: {
    clearAll: 'مسح الكل',
    apply: 'تطبيق',
    priceFrom: 'من',
    priceTo: 'إلى',
    inStock: 'المتوفر فقط',
    onSale: 'العروض',
  },
};

/**
 * Product filter sidebar with multiple filter types.
 */
export const ProductFilters = forwardRef<HTMLDivElement, ProductFiltersProps>(
  (
    {
      sections,
      activeFilters,
      onFiltersChange,
      isRtl = false,
      currency: _currency = 'KWD',
      showClearAll = true,
      collapsible = true,
      labels: customLabels,
      className,
      ...props
    },
    ref
  ) => {
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => {
      const initial: Record<string, boolean> = {};
      sections.forEach(s => {
        initial[s.id] = s.isExpanded !== false;
      });
      return initial;
    });

    const [localPriceRange, setLocalPriceRange] = useState<PriceRange | undefined>(
      activeFilters.priceRange
    );

    const labels = {
      ...defaultLabels[isRtl ? 'ar' : 'en'],
      ...customLabels,
    };

    const toggleSection = (sectionId: string) => {
      if (!collapsible) return;
      setExpandedSections(prev => ({
        ...prev,
        [sectionId]: !prev[sectionId],
      }));
    };

    const handleCheckboxChange = useCallback(
      (sectionId: string, optionId: string, checked: boolean) => {
        const currentValues = (activeFilters[sectionId] as string[]) || [];
        const newValues = checked
          ? [...currentValues, optionId]
          : currentValues.filter(v => v !== optionId);

        onFiltersChange({
          ...activeFilters,
          [sectionId]: newValues.length > 0 ? newValues : undefined,
        });
      },
      [activeFilters, onFiltersChange]
    );

    const handleRadioChange = useCallback(
      (sectionId: string, optionId: string) => {
        onFiltersChange({
          ...activeFilters,
          [sectionId]: [optionId],
        });
      },
      [activeFilters, onFiltersChange]
    );

    const handlePriceRangeChange = useCallback(() => {
      if (localPriceRange) {
        onFiltersChange({
          ...activeFilters,
          priceRange: localPriceRange,
        });
      }
    }, [activeFilters, localPriceRange, onFiltersChange]);

    const handleToggleChange = useCallback(
      (key: 'inStock' | 'onSale', checked: boolean) => {
        onFiltersChange({
          ...activeFilters,
          [key]: checked || undefined,
        });
      },
      [activeFilters, onFiltersChange]
    );

    const clearAllFilters = () => {
      onFiltersChange({});
      setLocalPriceRange(undefined);
    };

    const hasActiveFilters = Object.values(activeFilters).some(
      v => v !== undefined && (Array.isArray(v) ? v.length > 0 : true)
    );

    return (
      <div
        ref={ref}
        className={cn('space-y-6', className)}
        dir={isRtl ? 'rtl' : 'ltr'}
        role="region"
        aria-label={isRtl ? 'تصفية المنتجات' : 'Product filters'}
        {...props}
      >
        {/* Clear All */}
        {showClearAll && hasActiveFilters && (
          <button
            onClick={clearAllFilters}
            className="text-sm text-primary hover:text-primary/80 transition-colors"
          >
            {labels.clearAll}
          </button>
        )}

        {/* Quick Filters */}
        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={activeFilters.inStock || false}
              onChange={e => handleToggleChange('inStock', e.target.checked)}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
            />
            <span className="text-sm">{labels.inStock}</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={activeFilters.onSale || false}
              onChange={e => handleToggleChange('onSale', e.target.checked)}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
            />
            <span className="text-sm">{labels.onSale}</span>
          </label>
        </div>

        {/* Filter Sections */}
        {sections.map(section => (
          <div key={section.id} className="border-t border-border pt-4">
            {/* Section Header */}
            <button
              onClick={() => toggleSection(section.id)}
              className={cn(
                'w-full flex items-center justify-between text-sm font-semibold',
                collapsible && 'cursor-pointer hover:text-primary transition-colors'
              )}
              aria-expanded={expandedSections[section.id]}
              disabled={!collapsible}
            >
              <span>{isRtl && section.titleAr ? section.titleAr : section.title}</span>
              {collapsible && (
                <svg
                  className={cn(
                    'w-4 h-4 transition-transform',
                    expandedSections[section.id] && 'rotate-180'
                  )}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              )}
            </button>

            {/* Section Content */}
            {expandedSections[section.id] && (
              <div className="mt-3 space-y-2">
                {/* Checkbox / Radio Options */}
                {(section.type === 'checkbox' || section.type === 'radio') &&
                  section.options?.map(option => {
                    const isChecked = ((activeFilters[section.id] as string[]) || []).includes(
                      option.id
                    );
                    return (
                      <label
                        key={option.id}
                        className="flex items-center gap-3 cursor-pointer group"
                      >
                        <input
                          type={section.type}
                          name={section.id}
                          checked={isChecked}
                          onChange={e =>
                            section.type === 'checkbox'
                              ? handleCheckboxChange(section.id, option.id, e.target.checked)
                              : handleRadioChange(section.id, option.id)
                          }
                          className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                        />
                        <span className="text-sm group-hover:text-primary transition-colors flex-1">
                          {isRtl && option.labelAr ? option.labelAr : option.label}
                        </span>
                        {option.count !== undefined && (
                          <span className="text-xs text-muted-foreground">({option.count})</span>
                        )}
                      </label>
                    );
                  })}

                {/* Color Options */}
                {section.type === 'color' && section.colorOptions && (
                  <div className="flex flex-wrap gap-2">
                    {section.colorOptions.map(option => {
                      const isChecked = ((activeFilters[section.id] as string[]) || []).includes(
                        option.id
                      );
                      return (
                        <button
                          key={option.id}
                          onClick={() => handleCheckboxChange(section.id, option.id, !isChecked)}
                          className={cn(
                            'w-8 h-8 rounded-full border-2 transition-all',
                            isChecked
                              ? 'border-primary ring-2 ring-primary/20'
                              : 'border-border hover:border-primary/50'
                          )}
                          style={{ backgroundColor: option.color }}
                          aria-label={isRtl && option.labelAr ? option.labelAr : option.label}
                          aria-pressed={isChecked}
                        />
                      );
                    })}
                  </div>
                )}

                {/* Size Options */}
                {section.type === 'size' && section.options && (
                  <div className="flex flex-wrap gap-2">
                    {section.options.map(option => {
                      const isChecked = ((activeFilters[section.id] as string[]) || []).includes(
                        option.id
                      );
                      return (
                        <button
                          key={option.id}
                          onClick={() => handleCheckboxChange(section.id, option.id, !isChecked)}
                          className={cn(
                            'min-w-[40px] h-10 px-3 rounded-lg border text-sm font-medium transition-all',
                            isChecked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border hover:border-primary/50'
                          )}
                          aria-pressed={isChecked}
                        >
                          {isRtl && option.labelAr ? option.labelAr : option.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Price Range */}
                {section.type === 'price' && section.priceRange && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground">{labels.priceFrom}</label>
                        <input
                          type="number"
                          value={localPriceRange?.min ?? section.priceRange.min}
                          onChange={e =>
                            setLocalPriceRange(prev => ({
                              min: Number(e.target.value) * 1000,
                              max: prev?.max ?? section.priceRange!.max,
                            }))
                          }
                          className="w-full h-9 px-2 text-sm border border-border rounded-lg focus:border-primary focus:ring-1 focus:ring-primary"
                          min={0}
                        />
                      </div>
                      <span className="text-muted-foreground mt-5">-</span>
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground">{labels.priceTo}</label>
                        <input
                          type="number"
                          value={localPriceRange?.max ?? section.priceRange.max}
                          onChange={e =>
                            setLocalPriceRange(prev => ({
                              min: prev?.min ?? section.priceRange!.min,
                              max: Number(e.target.value) * 1000,
                            }))
                          }
                          className="w-full h-9 px-2 text-sm border border-border rounded-lg focus:border-primary focus:ring-1 focus:ring-primary"
                          min={0}
                        />
                      </div>
                    </div>
                    <button
                      onClick={handlePriceRangeChange}
                      className="w-full py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                    >
                      {labels.apply}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
);

ProductFilters.displayName = 'ProductFilters';
