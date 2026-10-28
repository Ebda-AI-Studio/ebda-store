'use client';

import { useEffect, useRef, useState } from 'react';
import { NOT_FOUND, sourcesAttr } from '../lib/not-found-copy';
import type { Locale } from '../lib/site';

/**
 * Header search: an icon that opens a panel with the search box. The box is a plain GET form to the help search
 * (works with no script); /assets/typeahead.js (loaded once in RootShell) turns it into the live combobox over the
 * marketing, help and docs indexes (help and docs answer CORS). Escape closes; opening focuses the input.
 */
export function HeaderSearch({ locale }: { locale: Locale }) {
  const c = NOT_FOUND[locale];
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // the combobox handles its own Escape (closing its list) first; a second Escape closes the panel
      if (e.key === 'Escape' && input.current?.getAttribute('aria-expanded') !== 'true')
        setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="hs" ref={root}>
      <button
        type="button"
        className="hs-btn"
        aria-expanded={open}
        aria-controls={`hs-panel-${locale}`}
        aria-label={c.searchLabel}
        onClick={() => setOpen(o => !o)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
      <div className="hs-panel" id={`hs-panel-${locale}`} hidden={!open}>
        <form
          className="search hs-form"
          role="search"
          action={`https://help.ebda.app${locale === 'ar' ? '' : '/en'}/search/`}
          method="get"
          data-sources={sourcesAttr(locale)}
        >
          <label className="sr-only" htmlFor={`hs-q-${locale}`}>
            {c.searchLabel}
          </label>
          <input
            ref={input}
            id={`hs-q-${locale}`}
            name="q"
            type="search"
            placeholder={c.searchPlaceholder}
            autoComplete="off"
            enterKeyHint="search"
          />
          <button type="submit">{c.searchButton}</button>
        </form>
      </div>
    </div>
  );
}
