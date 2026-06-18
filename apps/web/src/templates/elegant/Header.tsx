'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
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
  const { isRtl: ctxIsRtl } = useLanguage();
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
          <div className="hidden md:flex items-center justify-end gap-6 py-2 text-xs tracking-[0.15em] uppercase text-muted-foreground border-b border-border/50">
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
            'logo still small and not on the middle' — wadyaljuz uses
            this elegant template, my prior modern-only fixes didn't
            apply. */}
        <div className="relative flex items-center justify-between py-6 gap-6">
          {/* Mobile menu trigger */}
          <button
            type="button"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden inline-flex h-11 w-11 items-center justify-center text-foreground/60 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
            aria-label={isRtl ? 'القائمة' : 'Menu'}
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
              <Image
                src={displayLogo}
                alt={displayName}
                width={320}
                height={120}
                className="h-14 max-h-14 w-auto max-w-[150px] object-contain md:h-20 md:max-h-20 md:max-w-[210px]"
                priority
              />
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
              className="hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/50 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={isRtl ? 'بحث' : 'Search'}
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
              className="text-foreground/60 hover:text-foreground"
            />

            {/* Account */}
            <Link
              href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
              className="hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/50 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={isRtl ? 'الحساب' : 'Account'}
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
              className="relative hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/50 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={isRtl ? `السلة (${cartItemCount})` : `Cart (${cartItemCount})`}
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
                  d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
              {cartItemCount > 0 && (
                <span
                  className={`absolute -top-2 ${isRtl ? '-left-2' : '-right-2'} bg-foreground text-background text-[9px] font-medium w-4 h-4 rounded-full flex items-center justify-center`}
                >
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
              className="text-lg tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
            >
              {isRtl && item.labelAr ? item.labelAr : item.label}
            </Link>
          ))}
        </nav>

        {/* Mobile persistent search bar — always visible under the logo
            row on mobile (pecannbee target). Hidden on md+ where the
            expandable search toggle in the actions row handles it. */}
        <div className="md:hidden pb-4 -mt-2" data-zone="mobile-search">
          <form onSubmit={handleSearch} className="relative">
            <svg
              className={`absolute top-1/2 -translate-y-1/2 ${isRtl ? 'right-3' : 'left-3'} w-5 h-5 text-foreground/40 pointer-events-none`}
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
              placeholder={isRtl ? 'بحث' : 'Search'}
              className={`w-full ${isRtl ? 'pr-11 pl-4' : 'pl-11 pr-4'} py-3 bg-transparent border-b border-border focus:outline-none focus:border-foreground text-base sm:text-sm tracking-[0.08em] placeholder:text-muted-foreground/50 transition-colors duration-500`}
              dir={isRtl ? 'rtl' : 'ltr'}
              aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
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
          className={`hidden md:block overflow-visible transition-all duration-500 ${isSearchOpen ? 'max-h-24 opacity-100 py-6 border-t border-border/50' : 'max-h-0 opacity-0 py-0 pointer-events-none'}`}
        >
          <form onSubmit={handleSearch} className="relative max-w-lg mx-auto">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={isRtl ? 'ما الذي تبحث عنه؟' : 'What are you looking for?'}
              className="w-full px-0 py-3 bg-transparent border-0 border-b border-border focus:outline-none focus:border-foreground text-center text-base sm:text-sm tracking-[0.1em] placeholder:text-muted-foreground/50 transition-colors duration-500"
              dir={isRtl ? 'rtl' : 'ltr'}
              autoFocus={isSearchOpen}
              aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
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

        {/* Mobile menu */}
        {isMenuOpen && (
          <nav className="md:hidden py-6 border-t border-border/50">
            <ul className="space-y-5 text-center">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="inline-flex items-center justify-center min-h-11 text-lg tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </header>
  );
}
