'use client';

/**
 * Minimal searchable multi-select for promotion/coupon targeting scope
 * (`scopeProductIds` / `scopeCategoryIds`) — shared between the promotions
 * page and the coupon form so both use the identical picker. Empty
 * selection = whole cart (see promotion.routes.ts's createSchema comment);
 * a picker with both a product and a category selected means the two lists
 * UNION at evaluation time, not intersect.
 *
 * Categories are typically few, so the full list is fetched once and
 * filtered client-side. Products search the admin product list endpoint
 * (debounced) since a store's catalog can be large.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { apiGet } from '../../../../lib/api';
import { SearchPicker } from '@/components/SearchPicker';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface ScopeEntity {
  id: string;
  name: string;
  nameAr?: string | null;
}

interface ScopePickerProps {
  storeId: string;
  kind: 'products' | 'categories';
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  searchPlaceholder: string;
  emptyHint: string;
  removeLabel: string;
}

export function ScopePicker({
  storeId,
  kind,
  value,
  onChange,
  label,
  searchPlaceholder,
  emptyHint,
  removeLabel,
}: ScopePickerProps) {
  const locale = useLocale();
  const [query, setQuery] = useState('');
  const [categoryList, setCategoryList] = useState<ScopeEntity[]>([]);
  const [selectedDetails, setSelectedDetails] = useState<Record<string, ScopeEntity>>({});
  const valueRef = useRef(value);
  valueRef.current = value;

  const labelFor = (e: ScopeEntity) => (locale === 'ar' && e.nameAr ? e.nameAr : e.name);

  // Categories: fetch the full list once per store — used both for the
  // dropdown and to hydrate labels for already-selected ids.
  useEffect(() => {
    if (kind !== 'categories') return;
    (async () => {
      const { data } = await apiGet<{ categories: ScopeEntity[] }>(
        `/api/v1/stores/${storeId}/categories`
      );
      const list = data?.categories ?? [];
      setCategoryList(list);
      setSelectedDetails(prev => {
        const next = { ...prev };
        for (const c of list) next[c.id] = c;
        return next;
      });
    })();
  }, [kind, storeId]);

  // Products: hydrate labels for already-selected ids not yet known (e.g.
  // when editing an existing promotion/coupon).
  useEffect(() => {
    if (kind !== 'products') return;
    const missing = value.filter(id => !selectedDetails[id]);
    if (missing.length === 0) return;
    (async () => {
      const { data } = await apiGet<{ products: ScopeEntity[] }>(
        `/api/v1/stores/${storeId}/products?ids=${missing.join(',')}&limit=50`
      );
      const list = data?.products ?? [];
      if (list.length === 0) return;
      setSelectedDetails(prev => {
        const next = { ...prev };
        for (const p of list) next[p.id] = p;
        return next;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, storeId, value.join(',')]);

  // Products: search-as-you-type through SearchPicker (aborts the superseded request).
  const searchProducts = useCallback(
    async (q: string, signal: AbortSignal) => {
      const { data, error } = await apiGet<{ products: ScopeEntity[] }>(
        `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(q)}&limit=10`,
        undefined,
        signal
      );
      if (error) throw new Error(error.message);
      return (data?.products ?? []).filter(o => !valueRef.current.includes(o.id));
    },
    [storeId]
  );

  function add(entity: ScopeEntity) {
    if (value.includes(entity.id)) return;
    setSelectedDetails(prev => ({ ...prev, [entity.id]: entity }));
    onChange([...value, entity.id]);
    setQuery('');
  }

  function remove(id: string) {
    onChange(value.filter(v => v !== id));
  }

  // Categories: browsable without typing (short list), filtered client-side as the merchant types.
  const dropdownOptions = categoryList.filter(
    o =>
      !value.includes(o.id) &&
      (!query.trim() || labelFor(o).toLowerCase().includes(query.trim().toLowerCase()))
  );
  const showDropdown = dropdownOptions.length > 0;

  return (
    <div className="space-y-2">
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map(id => (
            <li
              key={id}
              className="flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-1 text-xs"
            >
              {selectedDetails[id] ? labelFor(selectedDetails[id]) : id}
              <button
                type="button"
                onClick={() => remove(id)}
                aria-label={removeLabel}
                className="text-muted-foreground hover:text-destructive-ink"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {kind === 'products' ? (
        <SearchPicker<ScopeEntity>
          search={searchProducts}
          getKey={o => o.id}
          onPick={add}
          placeholder={searchPlaceholder}
          renderOption={(o, hl) => hl(labelFor(o))}
        />
      ) : (
        <>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className={FIELD_CLASSES}
          />

          {showDropdown && (
            <ul className="max-h-40 overflow-y-auto rounded-md border border-border text-sm">
              {dropdownOptions.map(o => (
                <li key={o.id}>
                  <button
                    data-ui="row"
                    type="button"
                    onClick={() => add(o)}
                    className="block w-full px-3 py-2 text-start hover:bg-muted"
                  >
                    {labelFor(o)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!showDropdown && query.trim() && (
            <p className="px-1 text-sm text-muted-foreground">{emptyHint}</p>
          )}
        </>
      )}
    </div>
  );
}
