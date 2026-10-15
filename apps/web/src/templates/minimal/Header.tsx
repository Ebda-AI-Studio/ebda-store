'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { CartIcon } from '@ebda/ui';
import { StoreLogo } from '../shared/StoreLogo';
import { WORDMARK_NAV_LINK_CLASS, wordmarkClass } from '../shared/wordmark';
import type { HeaderProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
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
}: HeaderProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const lastScrollY = useRef(0);

  // Hide on scroll down, show on scroll up
  useEffect(() => {
    const onScroll = () => {
      const current = window.scrollY;
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

  // Only the qamar skin passes logoPlacement; undefined keeps the markup byte-identical.
  const isCentre = logoPlacement === 'centre';
  // Only the qamar skin passes wordmarkSize (W2a T-01); undefined keeps the markup byte-identical.
  const navLinkClass = wordmarkSize
    ? WORDMARK_NAV_LINK_CLASS
    : 'text-xs tracking-[0.18em] ui-caps-toggle font-normal text-muted-foreground hover:text-foreground transition-colors duration-200';
  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  return (
    <header
      className={`sticky top-0 z-50 bg-background transition-transform duration-300 ease-in-out ${
        isVisible ? 'translate-y-0' : '-translate-y-full'
      }`}
      style={headerBgColor ? { backgroundColor: headerBgColor } : undefined}
      dir={isRtl ? 'rtl' : 'ltr'}
      data-logo-placement={logoPlacement}
    >
      <div className="container mx-auto px-6">
        <div
          className={
            isCentre
              ? 'relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center py-3'
              : 'relative flex items-center justify-between py-3'
          }
        >
          {/* Logo — absolute-centered on mobile (visual middle of the
              row regardless of asymmetric hamburger/actions widths),
              normal flex item on lg+. Ahmad 2026-05-16 platform rule:
              every theme's logo MUST center on mobile. */}
          <Link
            href={urlPrefix || '/'}
            className={`absolute left-1/2 -translate-x-1/2 md:relative md:left-auto md:translate-x-0 flex items-center justify-center flex-shrink-0 ${
              isCentre
                ? 'min-w-0 max-w-[calc(100%-13rem)] md:max-w-[40vw] md:col-start-2'
                : 'max-w-[65%] md:max-w-none'
            }`}
          >
            {displayLogo ? (
              <StoreLogo src={displayLogo} alt={displayName} priority />
            ) : (
              <span
                className={
                  wordmarkSize
                    ? wordmarkClass(wordmarkSize)
                    : isCentre
                      ? 'block max-w-full truncate text-2xl sm:text-3xl font-display text-foreground'
                      : 'text-xs tracking-[0.3em] ui-caps-toggle font-light text-foreground'
                }
                data-zone="storeName"
                title={isCentre || wordmarkSize ? displayName : undefined}
              >
                {displayName}
              </span>
            )}
          </Link>

          {/* Desktop nav — centered absolutely */}
          <nav
            className={
              isCentre
                ? 'hidden lg:flex items-center gap-8 col-start-1 justify-self-start'
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
                : 'flex items-center gap-2'
            }
          >
            {/* Desktop-only search toggle — mobile has a persistent search
                bar below the logo row so a toggle here would be redundant. */}
            <button
              type="button"
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="hidden lg:inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
              className="relative hidden md:inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
              className="lg:hidden inline-flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              aria-label={t('Menu', 'القائمة')}
              aria-expanded={isMenuOpen}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
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
            row on mobile (pecannbee target layout). Hidden on lg+ where
            the expandable search-toggle in the actions row handles it. */}
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
              className="w-full ps-10 pe-3 py-2.5 text-base sm:text-xs tracking-wide bg-transparent border border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground transition-colors duration-200 rounded"
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
          className={`hidden lg:block overflow-visible transition-[max-height,opacity,padding] duration-300 ${
            isSearchOpen ? 'max-h-16 opacity-100 pb-4' : 'max-h-0 opacity-0 pointer-events-none'
          }`}
        >
          <form onSubmit={handleSearch} className="relative max-w-xs mx-auto">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('Search...', 'بحث...')}
              className="w-full text-center text-base sm:text-xs tracking-wide bg-transparent border-b border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground pb-2 transition-colors duration-200"
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
          <nav className="min-h-0 overflow-hidden">
            <ul className="space-y-5 pb-6 text-center">
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
