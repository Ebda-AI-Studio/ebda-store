'use client';

import { useState, useRef, useEffect, useCallback, useId, useMemo } from 'react';
import { EGYPT_GOVERNORATES, areasForGovernorate } from '@ebda/shared';
// Pure filter logic lives in a separate .ts file so vitest (node env) can
// import and unit-test it without a JSX transformer.
export { filterGovernorates, filterAreas } from './governorate-area-utils';

// Minimal shape of a row from GET /public/:storeId/shipping/area-rates
// (only the fields this component needs — CheckoutClient owns the full type).
export interface AreaRateRow {
  country: string;
  countryAr: string;
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
}

// --------------------------------------------------------------------------
// Single combobox primitive
// --------------------------------------------------------------------------

interface ComboboxOption {
  value: string; // EN canonical
  label: string; // display label, in the page language only (a11y re-audit P2-N13)
  /** Both languages, matched by the search box (an English query on the Arabic page still finds). */
  search?: string;
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
  /** Accessible name of the clear button, in the shopper's language (R-05). */
  clearLabel: string;
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
  clearLabel,
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
    ? options.filter(o => (o.search ?? o.label).toLowerCase().includes(query.toLowerCase()))
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
    ? 'border-destructive-ink ring-1 ring-destructive-ink focus-within:border-destructive-ink focus-within:ring-2 focus-within:ring-destructive-ink'
    : 'border-input focus-within:border-primary focus-within:ring-primary/20';

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
          // P2-8 (W4): the error text is announced with the field, and the field says it is invalid.
          aria-invalid={hasError ? true : undefined}
          aria-describedby={hasError ? `${id}-error` : undefined}
          type="text"
          disabled={disabled}
          placeholder={placeholder}
          value={displayValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onKeyDown={handleKeyDown}
          // text-base prevents iOS Safari auto-zoom on focus (any <16px triggers it)
          className="min-h-11 min-w-0 flex-1 py-2 text-base sm:text-sm bg-transparent outline-none disabled:cursor-not-allowed placeholder:text-muted-foreground"
          autoComplete="off"
        />
        {/* Clear button — shown when a value is selected */}
        {value && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={clearLabel}
            className="relative ms-1 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground before:absolute before:-inset-3 before:content-[''] hover:text-foreground hover:bg-muted transition-colors"
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
              {query ? 'مفيش نتايج / No results' : 'مفيش اختيارات / No options'}
            </li>
          ) : (
            filteredOptions.map((option, idx) => (
              <li
                key={option.value}
                id={`${listId}-option-${idx}`}
                role="option"
                aria-selected={option.value === value}
                onMouseDown={e => {
                  // mousedown fires before blur — prevent blur from closing the list
                  e.preventDefault();
                }}
                // QA-C7: the commit is the CLICK (pointer, touch tap and assistive-tech activation all fire
                // it; committing on mousedown missed taps and synthetic clicks, and a touch scroll of the
                // list used to select whatever the finger landed on).
                onClick={() => handleSelect(option)}
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
  /** Full rated-rows array — used to surface custom areas and multi-country selector */
  areaRates?: AreaRateRow[];
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
  areaRates,
  governorateError,
  areaError,
}: GovernorateAreaSelectProps) {
  const clearLabel = locale === 'ar' ? 'مسح الاختيار' : 'Clear selection';
  const govId = useId();
  const areaId = useId();
  const countryId = useId();

  // --------------------------------------------------------------------------
  // Multi-country: derive distinct countries from rated rows.
  // Only show the country selector when >1 distinct country exists.
  // --------------------------------------------------------------------------
  const countries = useMemo<ComboboxOption[]>(() => {
    if (!areaRates || areaRates.length === 0) return [];
    const seen = new Map<string, string>(); // en -> ar
    for (const r of areaRates) {
      if (!seen.has(r.country)) seen.set(r.country, r.countryAr);
    }
    if (seen.size <= 1) return []; // single-country: no dropdown needed
    return Array.from(seen.entries()).map(([en, ar]) => ({
      value: en,
      label: locale === 'ar' ? ar : en,
      search: `${en} ${ar}`,
    }));
  }, [areaRates, locale]);

  const isMultiCountry = countries.length > 1;

  // Internal country selection state (only meaningful when multi-country).
  // Default: first country from the list or 'Egypt' as fallback.
  const defaultCountry = useMemo(() => {
    if (!isMultiCountry) return '';
    // If the current governorate belongs to a country in the rates, use that.
    if (governorate && areaRates) {
      const match = areaRates.find(r => r.governorate === governorate);
      if (match) return match.country;
    }
    return countries[0]?.value ?? '';
  }, [isMultiCountry, governorate, areaRates, countries]);

  const [selectedCountry, setSelectedCountry] = useState(defaultCountry);

  // Sync selectedCountry when the parent clears governorate (e.g. a reset).
  useEffect(() => {
    if (!governorate && isMultiCountry && defaultCountry) {
      setSelectedCountry(defaultCountry);
    }
  }, [governorate, isMultiCountry, defaultCountry]);

  // --------------------------------------------------------------------------
  // Build the MERGED governorate option list:
  //   (a) Static Egypt govs that appear in ratedGovernorates
  //   (b) Custom govs from areaRates NOT in the static set
  // When multi-country, further filter to govs belonging to the active country.
  // --------------------------------------------------------------------------
  const governorateOptions = useMemo<ComboboxOption[]>(() => {
    // Compute effective country inline so this memo's deps are explicit state refs.
    const activeCountry = isMultiCountry ? selectedCountry : '';
    const staticGovNames = new Set(EGYPT_GOVERNORATES.map(g => g.en));

    // (a) Static govs that have at least one rated area (and match the active
    //     country when multi-country).
    const staticOptions: ComboboxOption[] = EGYPT_GOVERNORATES.filter(gov => {
      if (ratedGovernorates && ratedGovernorates.size > 0 && !ratedGovernorates.has(gov.en)) {
        return false;
      }
      if (isMultiCountry && areaRates) {
        // Confirm at least one rate for this gov belongs to the active country.
        const hasRateForCountry = areaRates.some(
          r => r.governorate === gov.en && r.country === activeCountry
        );
        if (!hasRateForCountry) return false;
      }
      return true;
    }).map(gov => ({
      value: gov.en,
      label: locale === 'ar' ? gov.ar : gov.en,
      search: `${gov.en} ${gov.ar}`,
    }));

    // (b) Custom govs: in areaRates but NOT in the static list.
    //     AR label comes from the first matching rate row.
    const customOptions: ComboboxOption[] = [];
    if (areaRates) {
      const seenCustom = new Set<string>();
      for (const r of areaRates) {
        if (staticGovNames.has(r.governorate)) continue;
        if (seenCustom.has(r.governorate)) continue;
        if (isMultiCountry && r.country !== activeCountry) continue;
        seenCustom.add(r.governorate);
        customOptions.push({
          value: r.governorate,
          label: locale === 'ar' ? r.governorateAr : r.governorate,
          search: `${r.governorate} ${r.governorateAr}`,
        });
      }
    }

    return [...staticOptions, ...customOptions];
  }, [ratedGovernorates, areaRates, isMultiCountry, selectedCountry, locale]);

  // --------------------------------------------------------------------------
  // Build the MERGED area option list for the selected governorate:
  //   (a) Static areas in that gov that are in ratedAreas
  //   (b) Custom areas from rate rows for this gov NOT in the static list
  // --------------------------------------------------------------------------
  const areaOptions = useMemo<ComboboxOption[]>(() => {
    if (!governorate) return [];

    const staticAreas = areasForGovernorate(governorate); // [] for custom govs
    const staticAreaNames = new Set(staticAreas.map(a => a.en));

    // (a) Static areas with a rate.
    const staticAreaOptions: ComboboxOption[] = staticAreas
      .filter(a => {
        if (ratedAreas && ratedAreas.size > 0 && !ratedAreas.has(a.en)) return false;
        return true;
      })
      .map(a => ({
        value: a.en,
        label: locale === 'ar' ? a.ar : a.en,
        search: `${a.en} ${a.ar}`,
      }));

    // (b) Custom areas: rate rows for this gov whose area is NOT in the static list.
    const customAreaOptions: ComboboxOption[] = [];
    if (areaRates) {
      for (const r of areaRates) {
        if (r.governorate !== governorate) continue;
        if (staticAreaNames.has(r.area)) continue;
        customAreaOptions.push({
          value: r.area,
          label: locale === 'ar' ? r.areaAr : r.area,
          search: `${r.area} ${r.areaAr}`,
        });
      }
    }

    return [...staticAreaOptions, ...customAreaOptions];
  }, [governorate, ratedAreas, areaRates, locale]);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------
  const handleCountrySelect = (countryEn: string) => {
    setSelectedCountry(countryEn);
    // Clear governorate + area when country switches.
    onChange('', '');
  };

  const handleCountryCleared = () => {
    setSelectedCountry(countries[0]?.value ?? '');
    onChange('', '');
  };

  const handleGovernorateSelect = (govEn: string) => {
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

  const countryLabel = locale === 'ar' ? 'الدولة' : 'Country';
  const countryPlaceholder = locale === 'ar' ? 'الدولة' : 'Country';
  const govLabel = locale === 'ar' ? 'المحافظة' : 'Governorate';
  const areaLabel = locale === 'ar' ? 'المنطقة' : 'Area';
  const govPlaceholder = locale === 'ar' ? 'المحافظة' : 'Governorate';
  const areaPlaceholder = locale === 'ar' ? 'المنطقة' : 'Area';

  // STOP-2 P2-3: the Area field is disabled until a governorate is chosen; an error the shopper
  // cannot act on yet is noise, so it waits.
  const shownAreaError = governorate ? areaError : undefined;

  return (
    <div className="space-y-4">
      {/* Country selector — only rendered for multi-country stores */}
      {isMultiCountry && (
        <div>
          <Combobox
            id={countryId}
            label={countryLabel}
            placeholder={countryPlaceholder}
            value={selectedCountry}
            options={countries}
            onSelect={handleCountrySelect}
            onClear={handleCountryCleared}
            clearLabel={clearLabel}
          />
        </div>
      )}

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
            clearLabel={clearLabel}
          />
          {governorateError && (
            <p id={`${govId}-error`} className="mt-1 text-sm text-destructive-ink">
              {governorateError}
            </p>
          )}
        </div>

        <div data-error={!!shownAreaError}>
          <Combobox
            id={areaId}
            label={areaLabel}
            placeholder={areaPlaceholder}
            value={area}
            options={areaOptions}
            disabled={!governorate}
            hasError={!!shownAreaError}
            onSelect={handleAreaSelect}
            onClear={handleAreaCleared}
            clearLabel={clearLabel}
          />
          {shownAreaError && (
            <p id={`${areaId}-error`} className="mt-1 text-sm text-destructive-ink">
              {shownAreaError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
