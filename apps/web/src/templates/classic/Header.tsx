'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { HeaderProps, ResolvedUtilityBar } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { SearchAutocomplete } from '../../components/SearchAutocomplete';

export default function ClassicHeader({
  branding,
  navigation = [],
  isRtl: isRtlProp,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
  urlPrefix = '',
  utilityBar,
}: HeaderProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && searchQuery.trim()) {
      onSearch(searchQuery);
    }
  };

  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  // Split navigation for left/right arrangement around centered logo
  const mid = Math.ceil(navigation.length / 2);
  const leftNav = navigation.slice(0, mid);
  const rightNav = navigation.slice(mid);

  // Resolve the utility bar: when the merchant hasn't saved a config we
  // fall back to the legacy Contact + About defaults so existing Classic
  // stores keep their bar. When the merchant explicitly disables it we
  // render nothing — no compensating padding is added to the main header
  // row below.
  const defaultUtilityLinks: ResolvedUtilityBar['links'] = [
    { label: 'Contact', labelAr: 'اتصل بنا', href: `${urlPrefix}/contact`, enabled: true },
    { label: 'About', labelAr: 'من نحن', href: `${urlPrefix}/about`, enabled: true },
  ];
  const utilityBarEnabled = utilityBar?.enabled !== false;
  const utilityBarLinks = (utilityBar?.links ?? defaultUtilityLinks).filter(
    link => link.enabled !== false
  );
  const showUtilityBar = utilityBarEnabled && utilityBarLinks.length > 0;

  return (
    <header
      className="sticky top-0 z-50 bg-background/95 backdrop-blur-md shadow-sm"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {/* Top utility bar — links sourced from `store.settings.utilityBar`
          with a Contact + About fallback so legacy Classic stores keep
          theirs. Hidden entirely when the merchant disables it. */}
      {showUtilityBar && (
        <div className="hidden md:block bg-foreground text-background py-2">
          <div className="container mx-auto px-4 flex items-center justify-end text-xs tracking-wide">
            <div className={`flex items-center gap-6 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {utilityBarLinks.map(link => (
                <Link
                  key={`${link.label}-${link.href}`}
                  href={link.href}
                  className="hover:opacity-70 transition-opacity duration-200"
                >
                  {isRtl && link.labelAr ? link.labelAr : link.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main header row — `relative` so the absolute-centered logo
          below is positioned to this row (Ahmad 2026-05-16: logo must
          truly center on mobile regardless of hamburger/actions
          widths). */}
      <div className="container mx-auto px-4 py-5">
        <div className="relative flex items-center justify-between gap-4">
          {/* Mobile menu toggle */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden inline-flex h-11 w-11 items-center justify-center cursor-pointer text-foreground hover:text-primary transition-colors duration-500"
            aria-label={isRtl ? 'القائمة' : 'Menu'}
            aria-expanded={isMenuOpen}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {isMenuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>

          {/* Desktop: left nav */}
          <nav
            className={`hidden md:flex items-center gap-8 flex-1 ${isRtl ? 'justify-end flex-row-reverse' : 'justify-start'}`}
          >
            {leftNav.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className="relative text-sm font-serif tracking-widest uppercase text-foreground/70 hover:text-foreground transition-colors duration-500 after:absolute after:bottom-0 after:left-0 after:w-0 after:h-px after:bg-foreground after:transition-all after:duration-300 hover:after:w-full"
              >
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}
          </nav>

          {/* Logo — absolute-centered on mobile (visual middle between
              hamburger + actions regardless of asymmetric widths),
              normal flex item on md+. max-w-[65%] guard prevents
              wide wordmarks from overflowing into the actions row at
              320px viewports. */}
          <Link
            href={urlPrefix || '/'}
            className="absolute left-1/2 -translate-x-1/2 md:relative md:left-auto md:translate-x-0 flex items-center justify-center flex-shrink-0 max-w-[65%] md:max-w-none"
          >
            {displayLogo ? (
              <Image
                src={displayLogo}
                alt={displayName}
                width={320}
                height={120}
                className="h-20 max-h-20 w-auto max-w-full object-contain sm:h-24 sm:max-h-24"
                priority
              />
            ) : (
              <span className="text-2xl font-serif font-bold tracking-wider text-foreground">
                {displayName}
              </span>
            )}
          </Link>

          {/* Desktop: right nav */}
          <nav
            className={`hidden md:flex items-center gap-8 flex-1 ${isRtl ? 'justify-start flex-row-reverse' : 'justify-end'}`}
          >
            {rightNav.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className="relative text-sm font-serif tracking-widest uppercase text-foreground/70 hover:text-foreground transition-colors duration-500 after:absolute after:bottom-0 after:left-0 after:w-0 after:h-px after:bg-foreground after:transition-all after:duration-300 hover:after:w-full"
              >
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}

            {/* Action icons */}
            <div className={`flex items-center gap-4 ${isRtl ? 'flex-row-reverse' : ''}`}>
              <button
                onClick={() => document.getElementById('classic-search-input')?.focus()}
                className="cursor-pointer text-foreground/60 hover:text-foreground transition-colors duration-500"
                aria-label={isRtl ? 'بحث' : 'Search'}
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </button>
              {/* Language toggle */}
              <LanguageSwitcher variant="compact" />

              <Link
                href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
                className="text-foreground/60 hover:text-foreground transition-colors duration-500"
                aria-label={isRtl ? 'الحساب' : 'Account'}
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
              </Link>
              <Link
                href={`${urlPrefix}/cart`}
                className="relative text-foreground/60 hover:text-foreground transition-colors duration-500 cursor-pointer"
                aria-label={
                  isRtl ? `سلة التسوق (${cartItemCount})` : `Cart (${cartItemCount} items)`
                }
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                  />
                </svg>
                {cartItemCount > 0 && (
                  <span
                    className={`absolute -top-2 ${isRtl ? '-left-2' : '-right-2'} bg-foreground text-background text-[10px] font-serif w-4 h-4 rounded-full flex items-center justify-center`}
                  >
                    {cartItemCount > 9 ? '9+' : cartItemCount}
                  </span>
                )}
              </Link>
            </div>
          </nav>

          {/* Mobile: action icons — Account moved into hamburger drawer
              to free row width for the centered logo. Only Cart visible
              here. Platform rule: Account hidden on mobile across all
              themes. */}
          <div className={`flex md:hidden items-center gap-1 ${isRtl ? 'flex-row-reverse' : ''}`}>
            <Link
              href={`${urlPrefix}/cart`}
              className="relative inline-flex h-11 w-11 items-center justify-center text-foreground/60 hover:text-foreground transition-colors duration-500 cursor-pointer"
              aria-label={isRtl ? 'السلة' : 'Cart'}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
              {cartItemCount > 0 && (
                <span
                  className={`absolute -top-2 ${isRtl ? '-left-2' : '-right-2'} bg-foreground text-background text-[10px] font-serif w-4 h-4 rounded-full flex items-center justify-center`}
                >
                  {cartItemCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </div>

      {/* Mobile persistent search bar — pecannbee target layout. Always
          visible under the main header row on mobile so customers don't
          have to open the menu to search. Hidden on md+. */}
      <div className="md:hidden border-t border-border/40 py-3" data-zone="mobile-search">
        <form onSubmit={handleSearch} className="relative container mx-auto px-4">
          <svg
            className={`absolute top-1/2 -translate-y-1/2 ${isRtl ? 'right-7' : 'left-7'} w-5 h-5 text-muted-foreground pointer-events-none`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={isRtl ? 'بحث' : 'Search'}
            className={`w-full ${isRtl ? 'pr-11 pl-4' : 'pl-11 pr-4'} py-2.5 border border-border bg-transparent font-serif text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground transition-colors duration-500 rounded`}
            dir={isRtl ? 'rtl' : 'ltr'}
            aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
          />
          <SearchAutocomplete query={searchQuery} onSelect={() => setSearchQuery('')} />
        </form>
      </div>

      {/* Desktop search bar — centered under the header on md+. */}
      <div className="hidden md:block border-t border-border/40 py-3">
        <form onSubmit={handleSearch} className="relative container mx-auto px-4 max-w-md">
          <input
            id="classic-search-input"
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={isRtl ? 'ابحث في مجموعتنا...' : 'Search our collection...'}
            className="w-full py-1.5 px-0 border-b border-border bg-transparent font-serif text-base sm:text-sm text-center text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground transition-colors duration-500"
            dir={isRtl ? 'rtl' : 'ltr'}
            aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
          />
          <SearchAutocomplete query={searchQuery} onSelect={() => setSearchQuery('')} />
        </form>
      </div>

      {/* Mobile menu */}
      {isMenuOpen && (
        <div className="md:hidden border-t border-border/40 bg-white dark:bg-background">
          <nav className="container mx-auto px-4 py-5" dir={isRtl ? 'rtl' : 'ltr'}>
            <ul className="space-y-1">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="block font-serif tracking-wider uppercase text-sm py-2.5 border-b border-border/20 text-foreground/70 hover:text-foreground transition-colors duration-500"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
            {/* Mobile search */}
            <form onSubmit={handleSearch} className="relative mt-5">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'بحث...' : 'Search...'}
                className="w-full py-2 px-0 border-b border-border bg-transparent text-sm font-serif text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground transition-colors duration-500"
                dir={isRtl ? 'rtl' : 'ltr'}
                aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
              />
              <SearchAutocomplete
                query={searchQuery}
                onSelect={() => {
                  setSearchQuery('');
                  setIsMenuOpen(false);
                }}
              />
            </form>
          </nav>
        </div>
      )}
    </header>
  );
}
