'use client';

import { Button } from '@/components/ui/Button';
import { SparkleIcon } from './SparkleIcon';
import { useEffect, useRef, useState } from 'react';
import { apiPost } from '../lib/api';
import { useT } from '@/i18n/useT';

/**
 * Auto-fetches AI category suggestions when the product name +
 * description are filled and renders them as clickable chips.
 *
 * Click → calls onSelect(categoryId). Parent decides what to do with
 * the choice (set the category dropdown, add to a multi-select, etc.).
 *
 * Debounces input by 800ms so we don't fire a call per keystroke. Caches
 * the last (name + description + storeId) tuple in state so editing
 * unrelated fields on the page doesn't re-trigger the call.
 *
 * Hidden when:
 *   - either name OR description is empty
 *   - the AI returned no matches
 *   - the parent has already set hasSelection=true (respects merchant's choice)
 */

interface CategorySuggestion {
  id: string;
  name: string;
  nameAr: string | null;
  confidence: 'high' | 'medium' | 'low';
}

interface AICategorySuggestionsProps {
  storeId: string;
  productName: string;
  productDescription: string;
  /** True when the merchant has already chosen a category — hides chips. */
  hasSelection: boolean;
  /** Called with the chosen category id when a chip is clicked. */
  onSelect: (categoryId: string) => void;
}

export function AICategorySuggestions({
  storeId,
  productName,
  productDescription,
  hasSelection,
  onSelect,
}: AICategorySuggestionsProps) {
  const t = useT('components.aiCategorySuggestions');
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastQueryRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Hide entirely when the merchant has chosen — never compete with their decision.
    if (hasSelection) {
      setSuggestions([]);
      return;
    }
    const name = productName.trim();
    const desc = productDescription.trim();
    if (!name || !desc) {
      setSuggestions([]);
      return;
    }

    // Cache: same input as last time, don't refire.
    const queryKey = `${storeId}::${name}::${desc}`;
    if (queryKey === lastQueryRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      lastQueryRef.current = queryKey;
      setLoading(true);
      setError(null);
      try {
        const { data, error: apiError } = await apiPost<{
          suggestions: CategorySuggestion[];
        }>(`/api/v1/stores/${storeId}/ai/suggest-categories`, {
          name,
          description: desc,
        });
        if (apiError || !data) {
          setError(apiError?.message ?? t('error', { error: 'failed' }));
          setSuggestions([]);
        } else {
          setSuggestions(data.suggestions ?? []);
        }
      } catch {
        setError(t('error', { error: 'network' }));
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 800);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [storeId, productName, productDescription, hasSelection, t]);

  if (hasSelection) return null;
  if (loading) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        <SparkleIcon /> {t('loading')}
      </p>
    );
  }
  if (error) {
    return <p className="mt-2 text-xs text-destructive-ink">{error}</p>;
  }
  if (suggestions.length === 0) return null;

  return (
    <div className="mt-2">
      <p className="mb-1.5 text-xs text-muted-foreground">
        <SparkleIcon /> {t('suggests')}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map(s => (
          <Button
            variant="outline"
            size="sm"
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className="gap-1.5"
            title={t('confidence', { level: s.confidence })}
          >
            <span>{s.name}</span>
            {s.confidence === 'high' && (
              <span className="text-xs uppercase tracking-wide opacity-60">
                {t('confidenceHigh')}
              </span>
            )}
          </Button>
        ))}
      </div>
    </div>
  );
}
