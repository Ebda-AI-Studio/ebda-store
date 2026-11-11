'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { useAuth } from '../lib/auth';
import { useFeatures } from '../hooks/useFeatures';
import { entryHref, entryLabel, searchRegistry } from '../lib/settings-search';

interface SearchResult {
  key: string;
  href: string;
  title: string;
  description: string;
}

/**
 * The search box on the Settings page. Searches the whole admin registry (lib/settings-registry.ts),
 * not just the cards on this page: any admin page and any individual setting, in Arabic or English,
 * with everyday synonyms; a result opens the page at the exact control (?setting=). Role- and
 * feature-gated exactly like the sidebar and the ⌘K palette.
 */
export function SettingsSearch({ storeId: storeIdProp }: { storeId?: string } = {}) {
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const isRtl = locale === 'ar';
  const t = useT('settings.settingsSearch');
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const storeId = storeIdProp ?? (typeof params?.id === 'string' ? params.id : '');
  const { user } = useAuth();
  const { isEnabled, isLoading: featuresLoading } = useFeatures();

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const results: SearchResult[] =
    query.trim() && storeId
      ? searchRegistry(query, {
          role: user?.role,
          isFeatureEnabled: isEnabled,
          featuresLoading,
        }).map(({ entry }) => ({
          key: entry.id,
          href: entryHref(storeId, entry),
          title: entryLabel(entry, locale),
          description:
            entry.kind === 'setting' ? ((locale === 'ar' ? entry.pageAr : entry.pageEn) ?? '') : '',
        }))
      : [];

  const navigate = useCallback(
    (href: string) => {
      setQuery('');
      setOpen(false);
      setActiveIndex(-1);
      router.push(href);
    },
    [router]
  );

  useEffect(() => {
    setOpen(query.trim().length > 0);
    setActiveIndex(-1);
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === 'Escape') {
      setQuery('');
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter' && activeIndex >= 0 && results[activeIndex]) {
      e.preventDefault();
      navigate(results[activeIndex].href);
    }
  }

  return (
    <div ref={containerRef} className="relative mb-6 w-full max-w-md" dir={isRtl ? 'rtl' : 'ltr'}>
      <label htmlFor="settings-search" className="sr-only">
        {t('placeholder')}
      </label>
      <div className="relative">
        <span
          className={`pointer-events-none absolute inset-y-0 ${isRtl ? 'right-3' : 'left-3'} flex items-center text-muted-foreground`}
          aria-hidden="true"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </span>
        <input
          id="settings-search"
          ref={inputRef}
          type="search"
          autoComplete="off"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (query.trim()) setOpen(true);
          }}
          placeholder={t('placeholder')}
          className={`w-full rounded-md border border-border bg-card py-2.5 text-sm text-foreground placeholder:text-muted-foreground shadow-sm transition focus:outline-none focus:ring-2 focus:ring-primary/50 ${isRtl ? 'pr-10 pl-4' : 'pl-10 pr-4'}`}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="settings-search-results"
          aria-activedescendant={
            activeIndex >= 0 ? `settings-search-result-${activeIndex}` : undefined
          }
        />
      </div>

      {open && (
        <div
          id="settings-search-results"
          role="listbox"
          aria-label={t('placeholder')}
          className="absolute z-50 mt-1.5 w-full rounded-md border border-border bg-card shadow-lg overflow-hidden"
        >
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t('noResults')}</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {results.map((result, i) => (
                <li
                  key={result.key}
                  id={`settings-search-result-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={e => {
                    e.preventDefault();
                    navigate(result.href);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`cursor-pointer px-4 py-2.5 transition-colors ${
                    i === activeIndex
                      ? 'bg-primary/10 text-primary-ink'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <p className="text-sm font-medium leading-tight">{result.title}</p>
                  {result.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground leading-snug line-clamp-1">
                      {result.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
