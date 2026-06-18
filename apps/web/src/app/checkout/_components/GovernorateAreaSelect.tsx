'use client';

import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { KUWAIT_GOVERNORATES, areasForGovernorate } from '@force/shared';
// Pure filter logic lives in a separate .ts file so vitest (node env) can
// import and unit-test it without a JSX transformer.
export { filterGovernorates, filterAreas } from './governorate-area-utils';

// --------------------------------------------------------------------------
// Single combobox primitive
// --------------------------------------------------------------------------

interface ComboboxOption {
  value: string; // EN canonical
  label: string; // display label (locale-aware)
}

interface ComboboxProps {
  id: string;
  label: string;
  placeholder: string;
  value: string; // EN canonical of current selection
  options: ComboboxOption[];
  disabled?: boolean;
  hasError?: boolean;
  onSelect: (value: string) => void;
  onClear: () => void;
}

function Combobox({
  id,
  label,
  placeholder,
  value,
  options,
  disabled = false,
  hasError = false,
  onSelect,
  onClear,
}: ComboboxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Display value: if something is selected and the input is not being edited,
  // show the option label; otherwise show query.
  const selectedOption = options.find(o => o.value === value);
  const displayValue = open ? query : (selectedOption?.label ?? '');

  const filteredOptions = query
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  // Click outside → close
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
        setActiveIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setOpen(true);
    setActiveIndex(-1);
  };

  const handleInputFocus = () => {
    if (!disabled) {
      setOpen(true);
      setQuery('');
    }
  };

  const handleSelect = useCallback(
    (option: ComboboxOption) => {
      onSelect(option.value);
      setQuery('');
      setOpen(false);
      setActiveIndex(-1);
    },
    [onSelect]
  );

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClear();
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setOpen(true);
        setActiveIndex(i => Math.min(i + 1, filteredOptions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && filteredOptions[activeIndex]) {
          handleSelect(filteredOptions[activeIndex]);
        }
        break;
      case 'Escape':
        setOpen(false);
        setQuery('');
        setActiveIndex(-1);
        break;
      default:
        break;
    }
  };

  const borderClass = hasError
    ? 'border-destructive focus-within:border-destructive focus-within:ring-destructive'
    : 'border-border focus-within:border-primary focus-within:ring-primary/20';

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className="block text-sm font-medium text-foreground mb-1">
        {label}
      </label>
      <div
        className={`flex items-center rounded-lg border bg-background px-3 focus-within:ring-2 transition-colors ${borderClass} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            activeIndex >= 0 && filteredOptions[activeIndex]
              ? `${listId}-option-${activeIndex}`
              : undefined
          }
          aria-autocomplete="list"
          aria-required
          type="text"
          disabled={disabled}
          placeholder={placeholder}
          value={displayValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onKeyDown={handleKeyDown}
          // text-base prevents iOS Safari auto-zoom on focus (any <16px triggers it)
          className="flex-1 py-2 text-base sm:text-sm bg-transparent outline-none disabled:cursor-not-allowed placeholder:text-muted-foreground"
          autoComplete="off"
        />
        {/* Clear button — shown when a value is selected */}
        {value && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear selection"
            className="ms-1 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
        {/* Chevron indicator */}
        <svg
          className={`ms-1 h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Dropdown list */}
      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-background shadow-lg"
        >
          {filteredOptions.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {query ? 'لا توجد نتائج / No results' : 'لا توجد خيارات / No options'}
            </li>
          ) : (
            filteredOptions.map((option, idx) => (
              <li
                key={option.value}
                id={`${listId}-option-${idx}`}
                role="option"
                aria-selected={option.value === value}
                onMouseDown={e => {
                  // mousedown fires before blur — prevent blur from closing
                  e.preventDefault();
                  handleSelect(option);
                }}
                className={`cursor-pointer px-3 py-2 text-sm transition-colors ${
                  option.value === value
                    ? 'bg-primary/10 text-primary font-medium'
                    : idx === activeIndex
                      ? 'bg-muted'
                      : 'hover:bg-muted'
                }`}
              >
                {option.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// GovernorateAreaSelect — the exported compound component
// --------------------------------------------------------------------------

interface GovernorateAreaSelectProps {
  governorate: string; // EN canonical, '' if unselected
  area: string; // EN canonical, '' if unselected
  onChange: (governorateEn: string, areaEn: string) => void;
  locale: 'ar' | 'en';
  ratedAreas?: Set<string>; // EN area names that have a shipping rate
  ratedGovernorates?: Set<string>; // EN gov names that have ≥1 rated area
  governorateError?: string;
  areaError?: string;
}

export function GovernorateAreaSelect({
  governorate,
  area,
  onChange,
  locale,
  ratedAreas,
  ratedGovernorates,
  governorateError,
  areaError,
}: GovernorateAreaSelectProps) {
  const govId = useId();
  const areaId = useId();

  // Build governorate options
  const governorateOptions: ComboboxOption[] = KUWAIT_GOVERNORATES.filter(gov => {
    if (ratedGovernorates && ratedGovernorates.size > 0 && !ratedGovernorates.has(gov.en)) {
      return false;
    }
    return true;
  }).map(gov => ({
    value: gov.en,
    label: locale === 'ar' ? `${gov.ar} / ${gov.en}` : `${gov.en} / ${gov.ar}`,
  }));

  // Build area options for selected governorate
  const areaOptions: ComboboxOption[] = governorate
    ? areasForGovernorate(governorate)
        .filter(a => {
          if (ratedAreas && ratedAreas.size > 0 && !ratedAreas.has(a.en)) return false;
          return true;
        })
        .map(a => ({
          value: a.en,
          label: locale === 'ar' ? `${a.ar} / ${a.en}` : `${a.en} / ${a.ar}`,
        }))
    : [];

  const handleGovernorateSelect = (govEn: string) => {
    // When governorate changes, clear area
    onChange(govEn, '');
  };

  const handleGovernorateCleared = () => {
    onChange('', '');
  };

  const handleAreaSelect = (areaEn: string) => {
    onChange(governorate, areaEn);
  };

  const handleAreaCleared = () => {
    onChange(governorate, '');
  };

  const govLabel = locale === 'ar' ? 'المحافظة *' : 'Governorate *';
  const areaLabel = locale === 'ar' ? 'المنطقة *' : 'Area *';
  const govPlaceholder = locale === 'ar' ? 'المحافظة' : 'Governorate';
  const areaPlaceholder = locale === 'ar' ? 'المنطقة' : 'Area';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div data-error={!!governorateError}>
        <Combobox
          id={govId}
          label={govLabel}
          placeholder={govPlaceholder}
          value={governorate}
          options={governorateOptions}
          hasError={!!governorateError}
          onSelect={handleGovernorateSelect}
          onClear={handleGovernorateCleared}
        />
        {governorateError && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {governorateError}
          </p>
        )}
      </div>

      <div data-error={!!areaError}>
        <Combobox
          id={areaId}
          label={areaLabel}
          placeholder={areaPlaceholder}
          value={area}
          options={areaOptions}
          disabled={!governorate}
          hasError={!!areaError}
          onSelect={handleAreaSelect}
          onClear={handleAreaCleared}
        />
        {areaError && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {areaError}
          </p>
        )}
      </div>
    </div>
  );
}
