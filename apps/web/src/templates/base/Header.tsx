'use client';

import { useState, useEffect, useRef, useId } from 'react';
import Link from '../../components/StoreLink';
import { CartIcon } from '@ebda/ui';
import { StoreLogo } from '../shared/StoreLogo';
import { StoreLockup } from '../shared/StoreLockup';
import { WORDMARK_NAV_LINK_CLASS, wordmarkClass } from '../shared/wordmark';

/** a11y P2-10 / rule (d): header text links measured 16-20px; every one is a 44px target. */
const HEADER_TARGET = 'inline-flex min-h-11 min-w-11 items-center justify-center';
import type { HeaderProps } from '../types';
import { useTabBarShown, HEADER_MENU_WITH_TAB_BAR } from '../shared/tab-bar-visibility';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { SearchAutocomplete } from '../../components/SearchAutocomplete';
import { countText, ITEMS } from '../../lib/plural';

export default function MinimalHeader({
  branding,
  navigation = [],
  isRtl: isRtlProp,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
  urlPrefix = '',
  headerBgColor,
  logoPlacement,
  wordmarkSize,
  lockup,
  searchPlacement,
}: HeaderProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const tabBarShown = useTabBarShown();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const lastScrollY = useRef(0);
  const headerRef = useRef<HTMLElement>(null);
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Hide on scroll down, show on scroll up
  useEffect(() => {
    const onScroll = () => {
      const current = window.scrollY;
      // 2.4.11: never hide the header while keyboard focus is inside it (the focus scroll itself
      // would otherwise hide it again).
      if (headerRef.current?.contains(document.activeElement)) {
        setIsVisible(true);
        lastScrollY.current = current;
        return;
      }
      // A header pinned by the page's "Sticky header" zone stays put (the mock-ups' bar never hides);
      // hiding it would leave a transparent band over the page and strand the sticky sub-bars.
      const zone = headerRef.current?.closest('[data-zone="header"]');
      if (zone && getComputedStyle(zone).position === 'sticky') {
        setIsVisible(true);
        lastScrollY.current = current;
        return;
      }
      if (current <= 0) {
        setIsVisible(true);
      } else if (current > lastScrollY.current + 4) {
        setIsVisible(false);
        setIsMenuOpen(false);
      } else if (current < lastScrollY.current - 4) {
        setIsVisible(true);
      }
      lastScrollY.current = current;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && searchQuery.trim()) {
      onSearch(searchQuery);
      setIsSearchOpen(false);
    }
  };

  // Only the souq skin passes searchPlacement (Ruling B2-1); undefined or `icon` keeps the markup
  // byte-identical (tests/unit/minimal-header-unchanged.test.tsx).
  const isProminent = searchPlacement === 'prominent';
  const handleProminentSearch = (e: React.FormEvent) => {
    const q = searchQuery.trim();
    // An empty query never navigates; with onSearch the client router takes over, without it the
    // form's own GET to /search?q= does (progressive enhancement).
    if (!q) {
      e.preventDefault();
      return;
    }
    if (onSearch) {
      e.preventDefault();
      onSearch(q);
    }
  };
  // Only the qamar skin passes logoPlacement; undefined keeps the markup byte-identical.
  const isCentre = logoPlacement === 'centre';
  // Only the qamar skin passes wordmarkSize (W2a T-01); undefined keeps the markup byte-identical.
  const navLinkClass = wordmarkSize
    ? `${HEADER_TARGET} ${WORDMARK_NAV_LINK_CLASS}`
    : HEADER_TARGET +
      ' text-xs tracking-[0.18em] ui-caps-toggle font-normal text-muted-foreground hover:text-foreground transition-colors duration-200';
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;
  // A name that cannot fit one line beside the actions wraps (two lines) and the row makes room.
  const longName = isProminent && displayName.length > 16;

  return (
    <header
      ref={headerRef}
      className={`sticky top-0 z-50 bg-background transition-transform duration-300 ease-in-out ${
        isVisible ? 'translate-y-0' : '-translate-y-full'
      }`}
      style={headerBgColor ? { backgroundColor: headerBgColor } : undefined}
      dir={isRtl ? 'rtl' : 'ltr'}
      data-logo-placement={logoPlacement}
      // 2.4.11: focus moving into the header (Shift+Tab, a click-less walk) brings it back on screen.
      onFocus={() => setIsVisible(true)}
    >
      <div className="container mx-auto px-6">
        <div
          // The logo is absolutely centred on phones, so it adds no height: a built-in lockup (a tall display
          // face, a stacked Latin line) would hang out of the bar. Reserve its height on the row.
          style={
            lockup && !displayLogo
              ? {
                  minHeight: Math.ceil(
                    lockup.size * 1.4 + (lockup.layout === 'stack' ? lockup.latinSize + 4 : 0) + 24
                  ),
                }
              : undefined
          }
          className={
            isCentre
              ? 'relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center py-3'
              : isProminent
                ? 'relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-3 py-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-x-4'
                : 'relative flex items-center justify-between py-3'
          }
        >
          {/* Logo — absolute-centered on mobile (visual middle of the
              row regardless of asymmetric hamburger/actions widths),
              normal flex item on lg+. Ahmad 2026-05-16 platform rule:
              every theme's logo MUST center on mobile. */}
          <Link
            href={urlPrefix || '/'}
            className={`absolute left-1/2 -translate-x-1/2 md:relative md:left-auto md:translate-x-0 flex min-h-11 min-w-11 items-center justify-center flex-shrink-0 ${
              isCentre
                ? 'max-w-[calc(100%-13rem)] md:max-w-[40vw] md:col-start-2'
                : isProminent
                  ? `top-3 ${logoPlacement ? 'max-w-[calc(100%-13rem)]' : 'max-w-[calc(100%-7rem)]'} md:top-auto md:col-start-1 md:row-start-1 md:max-w-[16rem]`
                  : logoPlacement
                    ? // the cart and language (96 px) sit on one side, so the centred logo may not reach them
                      'max-w-[calc(100%-13rem)] md:max-w-none'
                    : 'max-w-[65%] md:max-w-none'
            }`}
          >
            {displayLogo ? (
              <StoreLogo src={displayLogo} alt={displayName} priority />
            ) : lockup ? (
              <StoreLockup
                lockup={lockup}
                name={branding.name}
                nameAr={branding.nameAr}
                isRtl={!!isRtl}
              />
            ) : (
              <span
                className={
                  wordmarkSize
                    ? isProminent
                      ? // STOP-2: a long store name wraps to two lines here instead of ending in "...".
                        wordmarkClass(wordmarkSize).replace(
                          'truncate',
                          longName ? 'line-clamp-2 text-balance leading-snug' : 'truncate'
                        )
                      : wordmarkClass(wordmarkSize)
                    : isCentre
                      ? 'block max-w-full truncate text-2xl sm:text-3xl font-display text-foreground'
                      : 'text-xs tracking-[0.3em] ui-caps-toggle font-light text-foreground'
                }
                data-zone="storeName"
                translate="no"
                title={isCentre || wordmarkSize ? displayName : undefined}
              >
                {displayName}
              </span>
            )}
          </Link>

          {/* a11y M3: the search follows the logo in the DOM, as on screen (grid placement is explicit, so this is a pure DOM move): Tab goes logo, search, nav, actions. */}
          {isProminent && (
            <form
              role="search"
              action={`${urlPrefix}/search`}
              method="get"
              onSubmit={handleProminentSearch}
              className="relative col-span-2 row-start-2 md:col-span-1 md:col-start-2 md:row-start-1"
              data-zone="souq-search"
            >
              <label htmlFor={searchId} className="sr-only">
                {t('Search for a product or brand', translations['Search for a product or brand'])}
              </label>
              <svg
                className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref={searchInputRef}
                id={searchId}
                name="q"
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t(
                  'Search for a product or brand',
                  translations['Search for a product or brand']
                )}
                dir={isRtl ? 'rtl' : 'ltr'}
                className="h-11 w-full appearance-none rounded-[var(--radius)] border border-input bg-card ps-10 pe-11 text-base text-foreground placeholder:text-muted-foreground outline-none transition-colors duration-200 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-search-cancel-button]:appearance-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label={t('Clear search', translations['Clear search'])}
                  className="absolute inset-y-0 end-0 inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors duration-200 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <SearchAutocomplete
                query={searchQuery}
                onSelect={() => {
                  setSearchQuery('');
                }}
              />
            </form>
          )}

          {/* Desktop nav — centered absolutely */}
          <nav
            aria-label={t('Main', 'الرئيسية')}
            className={
              isCentre
                ? 'hidden lg:flex items-center gap-8 col-start-1 justify-self-start'
                : isProminent
                  ? 'hidden lg:flex items-center gap-8 lg:col-span-3 lg:row-start-2 lg:justify-self-center'
                  : 'hidden lg:flex items-center gap-10 absolute left-1/2 -translate-x-1/2'
            }
          >
            {navigation.map(item => (
              <Link key={item.href} href={item.href} className={navLinkClass}>
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}
          </nav>

          {/* Actions */}
          <div
            className={
              isCentre
                ? 'flex items-center gap-2 col-start-3 justify-self-end'
                : isProminent
                  ? `flex items-center gap-2 col-start-2 row-start-1 justify-self-end md:col-start-3 ${longName ? 'min-h-[4.5rem] md:min-h-0' : ''}`
                  : `flex items-center gap-2${logoPlacement ? ' ms-auto' : ''}`
            }
          >
            {/* Desktop-only search toggle — mobile has a persistent search
                bar below the logo row so a toggle here would be redundant. */}
            {!isProminent && (
              <button
                type="button"
                onClick={() => setIsSearchOpen(!isSearchOpen)}
                // P2-12: from md (the tab bar's search is gone there), not only lg.
                className="hidden md:inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                aria-label={t('Search', 'بحث')}
                aria-expanded={isSearchOpen}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={1}
                  aria-hidden="true"
                >
                  {isSearchOpen ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  )}
                </svg>
              </button>
            )}

            {/* Language toggle */}
            <LanguageSwitcher variant="compact" />

            {/* Account */}
            <Link
              href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
              className="hidden md:inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              aria-label={t('Account', 'الحساب')}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            </Link>

            {/* Cart */}
            <Link
              href={`${urlPrefix}/cart`}
              className={`relative ${tabBarShown ? 'hidden md:inline-flex' : 'inline-flex'} h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
              aria-label={t(
                `Cart (${countText('en', cartItemCount, ITEMS)})`,
                `سلة التسوق (${cartItemCount})`
              )}
            >
              <CartIcon className="w-4 h-4" strokeWidth={1} aria-hidden="true" />
              {cartItemCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 end-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground px-1 text-xs font-medium leading-none text-background tabular-nums"
                >
                  {cartItemCount}
                </span>
              )}
            </Link>

            {/* Mobile hamburger */}
            <button
              type="button"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className={`lg:hidden ${logoPlacement ? (isProminent ? 'max-lg:absolute max-lg:start-0 max-lg:top-3 ' : 'max-lg:absolute max-lg:start-0 max-lg:top-1/2 max-lg:-translate-y-1/2 ') : ''}inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${tabBarShown ? HEADER_MENU_WITH_TAB_BAR : ''}`}
              aria-label={t('Menu', 'القائمة')}
              aria-expanded={isMenuOpen}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                {isMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile persistent search bar — always visible under the logo
            row on mobile (demo-store target layout). Hidden on lg+ where
            the expandable search-toggle in the actions row handles it. */}
        {!isProminent && (
          <>
            <div className="hidden pb-3" data-zone="mobile-search">
              <form onSubmit={handleSearch} className="relative">
                <svg
                  className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-muted-foreground pointer-events-none"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={1}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('Search', 'بحث')}
                  className="min-h-11 w-full ps-10 pe-3 py-2.5 text-base sm:text-xs tracking-wide bg-transparent border border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground transition-colors duration-200 rounded"
                  dir={isRtl ? 'rtl' : 'ltr'}
                  aria-label={t('Search products', 'بحث عن المنتجات')}
                />
                <SearchAutocomplete
                  query={searchQuery}
                  onSelect={() => {
                    setSearchQuery('');
                  }}
                />
              </form>
            </div>

            {/* Desktop search field — smooth expand toggled by the search icon
            in the actions row. lg+ only since mobile has its own row above. */}
            <div
              className={`hidden md:block overflow-visible transition-[max-height,opacity,padding] duration-300 ${
                isSearchOpen ? 'max-h-16 opacity-100 pb-4' : 'max-h-0 opacity-0 pointer-events-none'
              }`}
            >
              <form onSubmit={handleSearch} className="relative max-w-xs mx-auto">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('Search...', 'بحث...')}
                  className="w-full text-center text-base sm:text-xs tracking-wide bg-transparent border-b border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground min-h-11 pb-2 transition-colors duration-200"
                  dir={isRtl ? 'rtl' : 'ltr'}
                  autoFocus={isSearchOpen}
                  aria-label={t('Search products', 'بحث عن المنتجات')}
                />
                <SearchAutocomplete
                  query={searchQuery}
                  onSelect={() => {
                    setSearchQuery('');
                    setIsSearchOpen(false);
                  }}
                />
              </form>
            </div>
          </>
        )}

        {/* Mobile menu — item 5 (2026-07-12): shared grid-rows enter/exit
            (220ms in / 160ms out, same axis both ways, motion-safe). Always
            rendered so the exit transition can play; `motion-reduce:duration-0`
            makes the open/close instant for reduced-motion users instead of
            skipping the toggle. `inert` + `aria-hidden` when collapsed so the
            visually-hidden nav can't take keyboard focus or be announced by
            screen readers (a11y parity with the previous conditional-mount
            behavior). */}
        <div
          className={`lg:hidden grid overflow-hidden transition-[grid-template-rows] ease-out motion-reduce:duration-0 ${isMenuOpen ? 'grid-rows-[1fr] duration-[220ms]' : 'grid-rows-[0fr] duration-[160ms]'}`}
          aria-hidden={!isMenuOpen}
          {...(!isMenuOpen
            ? ({ inert: true } as unknown as React.HTMLAttributes<HTMLDivElement>)
            : {})}
        >
          <nav aria-label={t('Menu', 'القائمة')} className="min-h-0 overflow-hidden">
            <ul className="space-y-1 pb-6 text-center">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={navLinkClass}
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </header>
  );
}
