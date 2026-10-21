'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CartIcon } from '@ebda/ui';
import { StoreLogo } from '../shared/StoreLogo';
import type { HeaderProps, ResolvedUtilityBar } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { SearchAutocomplete } from '../../components/SearchAutocomplete';

export default function ElegantHeader({
  branding,
  navigation = [],
  isRtl: isRtlProp,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
  urlPrefix = '',
  utilityBar,
  headerBgColor,
}: HeaderProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && searchQuery.trim()) {
      onSearch(searchQuery);
      setIsSearchOpen(false);
    }
  };

  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  // Resolve the utility bar: when the merchant hasn't saved a config we
  // fall back to the legacy Contact + Wishlist defaults so existing
  // Elegant stores keep their bar. When the merchant explicitly disables
  // the bar (`enabled: false`) we render nothing — and we deliberately
  // do NOT add compensating padding to the main header row below so the
  // logo/nav block sits flush against the announcement bar (or the page
  // top) like the other packs.
  const defaultUtilityLinks: ResolvedUtilityBar['links'] = [
    {
      label: 'Contact',
      labelAr: 'تواصل معنا',
      href: `${urlPrefix}/contact`,
      enabled: true,
    },
    {
      label: 'Wishlist',
      labelAr: 'المفضلة',
      href: `${urlPrefix}/wishlist`,
      enabled: true,
    },
  ];
  const utilityBarEnabled = utilityBar?.enabled !== false;
  const utilityBarLinks = (utilityBar?.links ?? defaultUtilityLinks).filter(
    link => link.enabled !== false
  );
  const showUtilityBar = utilityBarEnabled && utilityBarLinks.length > 0;

  return (
    <header
      className="sticky top-0 z-50 bg-background/95 backdrop-blur-md border-b border-border"
      style={headerBgColor ? { backgroundColor: headerBgColor } : undefined}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-4">
        {/* Top utility bar — links sourced from `store.settings.utilityBar`
            with a Contact + Wishlist fallback so legacy Elegant stores
            keep theirs. Hidden entirely when the merchant disables it. */}
        {showUtilityBar && (
          <div className="hidden md:flex items-center justify-end gap-6 py-2 text-xs tracking-[0.15em] ui-caps-toggle text-muted-foreground border-b border-border/50">
            {utilityBarLinks.map(link => (
              <Link
                key={`${link.label}-${link.href}`}
                href={link.href}
                className="hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              >
                {isRtl && link.labelAr ? link.labelAr : link.label}
              </Link>
            ))}
          </div>
        )}

        {/* Main header row — absolute-centered logo on mobile so it's
            visually balanced between hamburger (left) + actions (right)
            regardless of asymmetric widths. Desktop falls back to the
            spacer pattern with normal flex flow. Ahmad 2026-05-16
            'logo still small and not on the middle' — demo-merchant uses
            this elegant template, my prior modern-only fixes didn't
            apply. */}
        <div className="relative flex items-center justify-between py-6 gap-6">
          {/* Mobile menu trigger */}
          <button
            type="button"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden inline-flex h-11 w-11 items-center justify-center text-foreground/70 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
            aria-label={t('Menu', 'القائمة')}
            aria-expanded={isMenuOpen}
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={1}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d={isMenuOpen ? 'M6 18L18 6M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'}
              />
            </svg>
          </button>

          {/* Spacer for logo centering on desktop */}
          <div className="hidden md:flex flex-1" />

          {/* Logo — absolute-centered on mobile, normal flex on md+. */}
          <Link
            href={urlPrefix || '/'}
            className="absolute left-1/2 -translate-x-1/2 md:relative md:left-auto md:translate-x-0 flex items-center justify-center flex-shrink-0 cursor-pointer max-w-[65%] md:max-w-none"
          >
            {displayLogo ? (
              <StoreLogo src={displayLogo} alt={displayName} priority />
            ) : (
              <span
                className="text-3xl font-light tracking-[0.25em] text-foreground"
                data-zone="storeName"
              >
                {displayName}
              </span>
            )}
          </Link>

          {/* Actions — right */}
          <div className="flex items-center gap-2 flex-1 justify-end">
            {/* Search */}
            <button
              type="button"
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/70 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={t('Search', 'بحث')}
            >
              <svg
                className="w-5 h-5"
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
            </button>

            {/* Language toggle — visible on every breakpoint so customers
                can switch even when the rest of the actions row collapses. */}
            <LanguageSwitcher
              variant="compact"
              className="text-foreground/70 hover:text-foreground"
            />

            {/* Account */}
            <Link
              href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
              className="hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/70 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={t('Account', 'الحساب')}
            >
              <svg
                className="w-5 h-5"
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
              className="relative hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/70 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={t(`Cart (${cartItemCount})`, `السلة (${cartItemCount})`)}
            >
              <CartIcon className="w-5 h-5" strokeWidth={1} aria-hidden="true" />
              {cartItemCount > 0 && (
                <span className="absolute -top-2 -end-2 bg-foreground text-background text-xs font-medium h-[18px] min-w-[18px] px-1 rounded-full tabular-nums flex items-center justify-center">
                  {cartItemCount > 9 ? '9+' : cartItemCount}
                </span>
              )}
            </Link>
          </div>
        </div>

        {/* Desktop navigation — below logo */}
        <nav className="hidden md:flex items-center justify-center gap-10 pb-5">
          {navigation.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="text-lg tracking-[0.18em] ui-caps-toggle text-muted-foreground hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
            >
              {isRtl && item.labelAr ? item.labelAr : item.label}
            </Link>
          ))}
        </nav>

        {/* Mobile persistent search bar — always visible under the logo
            row on mobile (demo-store target). Hidden on md+ where the
            expandable search toggle in the actions row handles it. */}
        <div className="hidden pb-4 -mt-2" data-zone="mobile-search">
          <form onSubmit={handleSearch} className="relative">
            <svg
              className="absolute top-1/2 -translate-y-1/2 start-3 w-5 h-5 text-foreground/70 pointer-events-none"
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
              className="w-full ps-11 pe-4 py-3 bg-transparent border-b border-border focus:outline-none focus:border-foreground text-base sm:text-sm tracking-[0.08em] placeholder:text-muted-foreground transition-colors duration-500"
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

        {/* Desktop search field — expands below nav on md+ only. */}
        <div
          className={`hidden md:block overflow-visible transition-[max-height,opacity,padding,border-width] duration-500 ${isSearchOpen ? 'max-h-24 opacity-100 py-6 border-t border-border/50' : 'max-h-0 opacity-0 py-0 pointer-events-none'}`}
        >
          <form onSubmit={handleSearch} className="relative max-w-lg mx-auto">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('What are you looking for?', 'ما الذي تبحث عنه؟')}
              className="w-full px-0 py-3 bg-transparent border-0 border-b border-border focus:outline-none focus:border-foreground text-center text-base sm:text-sm tracking-[0.1em] placeholder:text-muted-foreground transition-colors duration-500"
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
          className={`md:hidden grid overflow-hidden transition-[grid-template-rows] ease-out motion-reduce:duration-0 border-t border-border/50 ${isMenuOpen ? 'grid-rows-[1fr] duration-[220ms]' : 'grid-rows-[0fr] duration-[160ms]'}`}
          aria-hidden={!isMenuOpen}
          {...(!isMenuOpen
            ? ({ inert: true } as unknown as React.HTMLAttributes<HTMLDivElement>)
            : {})}
        >
          <nav className="min-h-0 overflow-hidden">
            <ul className="space-y-5 py-6 text-center">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="inline-flex items-center justify-center min-h-11 text-lg tracking-[0.18em] ui-caps-toggle text-muted-foreground hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
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
