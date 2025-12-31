'use client';

import { forwardRef, useState, useCallback, useRef, useEffect } from 'react';
import { cn } from '../utils/cn';

export interface SearchSuggestion {
  id: string;
  type: 'product' | 'category' | 'brand' | 'query';
  text: string;
  textAr?: string;
  image?: string;
  price?: number;
  url?: string;
}

export interface SearchBarProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'onSubmit' | 'size'
> {
  /** Current search value */
  value?: string;
  /** Callback when value changes */
  onChange?: (value: string) => void;
  /** Callback when search is submitted */
  onSubmit?: (value: string) => void;
  /** Search suggestions */
  suggestions?: SearchSuggestion[];
  /** Callback when suggestion is selected */
  onSuggestionSelect?: (suggestion: SearchSuggestion) => void;
  /** Loading state for suggestions */
  isLoading?: boolean;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Currency for price display */
  currency?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant */
  variant?: 'default' | 'minimal' | 'filled' | 'outline';
  /** Show clear button */
  showClearButton?: boolean;
  /** Auto focus on mount */
  autoFocus?: boolean;
  /** Custom labels */
  labels?: Partial<{
    placeholder: string;
    clear: string;
    search: string;
    noResults: string;
    products: string;
    categories: string;
    brands: string;
    recentSearches: string;
  }>;
}

const sizeStyles = {
  sm: {
    input: 'h-9 text-sm pl-9 pr-3',
    icon: 'w-4 h-4 left-3',
    clear: 'w-4 h-4',
    suggestions: 'text-sm',
  },
  md: {
    input: 'h-11 text-base pl-11 pr-4',
    icon: 'w-5 h-5 left-3.5',
    clear: 'w-5 h-5',
    suggestions: 'text-sm',
  },
  lg: {
    input: 'h-14 text-lg pl-12 pr-5',
    icon: 'w-6 h-6 left-4',
    clear: 'w-6 h-6',
    suggestions: 'text-base',
  },
};

const variantStyles = {
  default:
    'bg-background border border-border focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
  minimal: 'bg-transparent border-b border-border focus-within:border-primary',
  filled:
    'bg-muted border border-transparent focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
  outline: 'bg-transparent border-2 border-border focus-within:border-primary',
};

const defaultLabels = {
  en: {
    placeholder: 'Search products...',
    clear: 'Clear search',
    search: 'Search',
    noResults: 'No results found',
    products: 'Products',
    categories: 'Categories',
    brands: 'Brands',
    recentSearches: 'Recent Searches',
  },
  ar: {
    placeholder: 'ابحث عن المنتجات...',
    clear: 'مسح البحث',
    search: 'بحث',
    noResults: 'لا توجد نتائج',
    products: 'المنتجات',
    categories: 'الفئات',
    brands: 'العلامات التجارية',
    recentSearches: 'عمليات البحث الأخيرة',
  },
};

/**
 * Search bar with suggestions dropdown and keyboard navigation.
 */
export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  (
    {
      value: controlledValue,
      onChange,
      onSubmit,
      suggestions = [],
      onSuggestionSelect,
      isLoading = false,
      isRtl = false,
      currency = 'KWD',
      size = 'md',
      variant = 'default',
      showClearButton = true,
      autoFocus = false,
      labels: customLabels,
      className,
      ...props
    },
    ref
  ) => {
    const [internalValue, setInternalValue] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Support both controlled and uncontrolled modes
    const value = controlledValue ?? internalValue;

    const labels = {
      ...defaultLabels[isRtl ? 'ar' : 'en'],
      ...customLabels,
    };

    const styles = sizeStyles[size];

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        if (controlledValue === undefined) {
          setInternalValue(newValue);
        }
        onChange?.(newValue);
        setIsOpen(newValue.length > 0);
        setActiveIndex(-1);
      },
      [controlledValue, onChange]
    );

    const handleClear = useCallback(() => {
      if (controlledValue === undefined) {
        setInternalValue('');
      }
      onChange?.('');
      setIsOpen(false);
      inputRef.current?.focus();
    }, [controlledValue, onChange]);

    const handleSubmit = useCallback(
      (e?: React.FormEvent) => {
        e?.preventDefault();
        if (value.trim()) {
          onSubmit?.(value.trim());
          setIsOpen(false);
        }
      },
      [value, onSubmit]
    );

    const handleSuggestionClick = useCallback(
      (suggestion: SearchSuggestion) => {
        onSuggestionSelect?.(suggestion);
        if (controlledValue === undefined) {
          setInternalValue(suggestion.text);
        }
        setIsOpen(false);
      },
      [controlledValue, onSuggestionSelect]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!isOpen || suggestions.length === 0) {
          if (e.key === 'Enter') {
            handleSubmit();
          }
          return;
        }

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setActiveIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : 0));
            break;
          case 'ArrowUp':
            e.preventDefault();
            setActiveIndex(prev => (prev > 0 ? prev - 1 : suggestions.length - 1));
            break;
          case 'Enter':
            e.preventDefault();
            if (activeIndex >= 0 && suggestions[activeIndex]) {
              handleSuggestionClick(suggestions[activeIndex]);
            } else {
              handleSubmit();
            }
            break;
          case 'Escape':
            setIsOpen(false);
            setActiveIndex(-1);
            break;
        }
      },
      [isOpen, suggestions, activeIndex, handleSubmit, handleSuggestionClick]
    );

    // Close on outside click
    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          setIsOpen(false);
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Group suggestions by type
    const groupedSuggestions = suggestions.reduce(
      (acc, suggestion) => {
        if (!acc[suggestion.type]) {
          acc[suggestion.type] = [];
        }
        acc[suggestion.type].push(suggestion);
        return acc;
      },
      {} as Record<string, SearchSuggestion[]>
    );

    const formatPrice = (price: number) => {
      return new Intl.NumberFormat(isRtl ? 'ar-KW' : 'en-KW', {
        style: 'currency',
        currency,
        minimumFractionDigits: currency === 'KWD' ? 3 : 2,
      }).format(price / 1000);
    };

    const getTypeLabel = (type: string) => {
      switch (type) {
        case 'product':
          return labels.products;
        case 'category':
          return labels.categories;
        case 'brand':
          return labels.brands;
        case 'query':
          return labels.recentSearches;
        default:
          return type;
      }
    };

    return (
      <div ref={containerRef} className="relative w-full" dir={isRtl ? 'rtl' : 'ltr'}>
        <form onSubmit={handleSubmit} role="search">
          <div
            className={cn(
              'relative flex items-center rounded-lg transition-all',
              variantStyles[variant],
              variant === 'minimal' && 'rounded-none',
              className
            )}
          >
            {/* Search Icon */}
            <svg
              className={cn(
                'absolute text-muted-foreground transition-colors',
                styles.icon,
                isRtl && 'left-auto right-3'
              )}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>

            {/* Input */}
            <input
              ref={node => {
                (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
                if (typeof ref === 'function') ref(node);
                else if (ref)
                  (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
              }}
              type="search"
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => value.length > 0 && setIsOpen(true)}
              placeholder={labels.placeholder}
              autoFocus={autoFocus}
              autoComplete="off"
              className={cn(
                'w-full bg-transparent outline-none placeholder:text-muted-foreground',
                styles.input,
                isRtl && 'pl-3 pr-11',
                showClearButton && value && 'pr-10',
                isRtl && showClearButton && value && 'pl-10 pr-11'
              )}
              aria-label={labels.search}
              aria-expanded={isOpen}
              aria-haspopup="listbox"
              role="combobox"
              aria-autocomplete="list"
              {...props}
            />

            {/* Clear Button */}
            {showClearButton && value && (
              <button
                type="button"
                onClick={handleClear}
                className={cn(
                  'absolute p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
                  isRtl ? 'left-2' : 'right-2'
                )}
                aria-label={labels.clear}
              >
                <svg className={styles.clear} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}

            {/* Loading Spinner */}
            {isLoading && (
              <div className={cn('absolute', isRtl ? 'left-10' : 'right-10')}>
                <svg
                  className={cn('animate-spin text-muted-foreground', styles.clear)}
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              </div>
            )}
          </div>
        </form>

        {/* Suggestions Dropdown */}
        {isOpen && (
          <div
            className={cn(
              'absolute z-50 w-full mt-2 bg-background border border-border rounded-lg shadow-lg overflow-hidden',
              styles.suggestions
            )}
            role="listbox"
          >
            {suggestions.length === 0 && !isLoading ? (
              <div className="px-4 py-3 text-muted-foreground text-center">{labels.noResults}</div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {Object.entries(groupedSuggestions).map(([type, items]) => (
                  <div key={type}>
                    <div className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide bg-muted/50">
                      {getTypeLabel(type)}
                    </div>
                    <ul>
                      {items.map(suggestion => {
                        const flatIndex = suggestions.indexOf(suggestion);
                        return (
                          <li key={suggestion.id}>
                            <button
                              type="button"
                              onClick={() => handleSuggestionClick(suggestion)}
                              className={cn(
                                'w-full flex items-center gap-3 px-4 py-2 text-left transition-colors',
                                flatIndex === activeIndex
                                  ? 'bg-primary/10 text-primary'
                                  : 'hover:bg-muted'
                              )}
                              role="option"
                              aria-selected={flatIndex === activeIndex}
                            >
                              {/* Image for products */}
                              {suggestion.type === 'product' && suggestion.image ? (
                                <div className="w-10 h-10 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                                  <img
                                    src={suggestion.image}
                                    alt=""
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                              ) : (
                                <div className="w-6 h-6 flex items-center justify-center text-muted-foreground flex-shrink-0">
                                  {suggestion.type === 'category' && (
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
                                      />
                                    </svg>
                                  )}
                                  {suggestion.type === 'brand' && (
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                                      />
                                    </svg>
                                  )}
                                  {suggestion.type === 'query' && (
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                                      />
                                    </svg>
                                  )}
                                </div>
                              )}

                              {/* Text */}
                              <div className="flex-1 min-w-0">
                                <p className="truncate">
                                  {isRtl && suggestion.textAr ? suggestion.textAr : suggestion.text}
                                </p>
                              </div>

                              {/* Price for products */}
                              {suggestion.type === 'product' && suggestion.price !== undefined && (
                                <span className="text-sm font-medium text-primary flex-shrink-0">
                                  {formatPrice(suggestion.price)}
                                </span>
                              )}

                              {/* Arrow for navigation */}
                              <svg
                                className="w-4 h-4 text-muted-foreground flex-shrink-0"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d={isRtl ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
                                />
                              </svg>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';
