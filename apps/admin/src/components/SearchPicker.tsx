'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { highlightSegments, useListboxNav, useLiveSearch } from '@ebda/ui';
import { useT } from '@/i18n/useT';

interface SearchPickerProps<T> {
  /** One search. Pass `signal` to the fetch: a superseded request is aborted. */
  search: (query: string, signal: AbortSignal) => Promise<T[]>;
  getKey: (item: T) => string;
  /** Row content; `highlight(text)` marks the typed words (Arabic-folded). */
  renderOption: (item: T, highlight: (text: string) => ReactNode) => ReactNode;
  onPick: (item: T) => void;
  placeholder: string;
  ariaLabel?: string;
  /** Controlled text. Omit for an uncontrolled box that clears itself after a pick. */
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  /** Shortest query that searches. Default 1: one Arabic letter is a word. */
  minChars?: number;
  className?: string;
  inputClassName?: string;
}

const INPUT =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';

/**
 * Admin search-as-you-type picker (orders new, bundle items, promotion scope): results from the 1st
 * character after 150 ms, the superseded request aborted, only results for the current text shown,
 * ARIA combobox (arrows / Home / End / Enter / Escape), Arabic-folded highlight, and loading / empty /
 * error rows. Spec: docs/plans/done/2026-10-26-search-as-you-type.md.
 */
export function SearchPicker<T>({
  search,
  getKey,
  renderOption,
  onPick,
  placeholder,
  ariaLabel,
  value,
  onValueChange,
  disabled,
  minChars = 1,
  className,
  inputClassName,
}: SearchPickerProps<T>) {
  const t = useT('common.liveSearch');
  const [inner, setInner] = useState('');
  const controlled = value !== undefined;
  const text = controlled ? value : inner;
  const setText = useCallback(
    (v: string) => {
      if (!controlled) setInner(v);
      onValueChange?.(v);
    },
    [controlled, onValueChange]
  );

  // Open only while the merchant is typing: a programmatic text (e.g. the picked customer's name) must
  // not re-run the search.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveSearch<T>({
    query: text,
    search,
    minChars,
    enabled: open && !disabled,
  });

  const shown = open && live.status !== 'idle';
  const pick = useCallback(
    (index: number) => {
      const item = live.results[index];
      if (!item) return;
      setOpen(false);
      if (!controlled) setInner('');
      onPick(item);
    },
    [live.results, controlled, onPick]
  );
  const nav = useListboxNav({ count: live.results.length, open: shown, setOpen, onPick: pick });
  const { setActiveIndex } = nav;
  useEffect(() => setActiveIndex(-1), [live.settledQuery, setActiveIndex]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const highlight = (s: string) =>
    highlightSegments(s, live.settledQuery).map((seg, i) =>
      seg.match ? (
        <mark key={i} className="rounded-sm bg-primary/15 text-inherit">
          {seg.text}
        </mark>
      ) : (
        <span key={i}>{seg.text}</span>
      )
    );

  const announce =
    live.status === 'ready'
      ? live.results.length === 0
        ? t('empty', { q: live.settledQuery })
        : t('count', { n: live.results.length })
      : live.status === 'loading'
        ? t('loading')
        : live.status === 'error'
          ? t('error')
          : '';

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <input
        type="text"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        enterKeyHint="search"
        className={inputClassName ?? INPUT}
        {...nav.inputProps}
        aria-expanded={shown}
        onChange={e => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => text.trim().length >= minChars && setOpen(true)}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {shown ? announce : ''}
      </p>
      {shown && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-card shadow-lg">
          {live.status === 'loading' && (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t('loading')}</p>
          )}
          {live.status === 'error' && (
            <p className="px-3 py-2 text-sm text-destructive-ink">{t('error')}</p>
          )}
          {live.status === 'ready' && live.results.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {t('empty', { q: live.settledQuery })}
            </p>
          )}
          <ul
            {...nav.listProps}
            aria-label={ariaLabel ?? placeholder}
            hidden={live.status !== 'ready' || live.results.length === 0}
          >
            {live.results.map((item, i) => (
              <li
                key={getKey(item)}
                id={nav.optionId(i)}
                role="option"
                aria-selected={nav.activeIndex === i}
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(i)}
                className={`min-h-[44px] cursor-pointer px-3 py-2 text-start text-sm hover:bg-muted ${nav.activeIndex === i ? 'bg-muted' : ''}`}
              >
                {renderOption(item, highlight)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
