'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { CartIcon } from '@ebda/ui';
import { StoreLogo } from '../shared/StoreLogo';
import type { HeaderProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { SearchAutocomplete } from '../../components/SearchAutocomplete';

export default function BoldHeader({
  branding,
  navigation = [],
  isRtl: isRtlProp,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
  urlPrefix = '',
  headerBgColor,
}: HeaderProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store } = useStore();
  const isRtl = isRtlProp ?? ctxIsRtl;
  // Item 2 (2026-07-12) persona-completion: bold's bordered-header chrome
  // (design.md "border-2 header") — same border color already in use
  // (border-white/10), just applied on all sides instead of only bottom.
  // No new color, chrome only.
  const personaBorder = store.theme?.personaChromeV2 === true;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [prevCartCount, setPrevCartCount] = useState(cartItemCount);
  const [cartPulse, setCartPulse] = useState(false);

  useEffect(() => {
    if (cartItemCount > prevCartCount) {
      setCartPulse(true);
      const t = setTimeout(() => setCartPulse(false), 600);
      return () => clearTimeout(t);
    }
    setPrevCartCount(cartItemCount);
    return undefined;
  }, [cartItemCount, prevCartCount]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && searchQuery.trim()) {
      onSearch(searchQuery);
      setIsSearchOpen(false);
    }
  };

  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  return (
    <>
      <header
        className={`bg-gray-950 text-white sticky top-0 z-50 border-white/10 ${personaBorder ? 'border-2' : 'border-b'}`}
        style={headerBgColor ? { backgroundColor: headerBgColor } : undefined}
      >
        <div className="container mx-auto px-4">
          {/* Row 1: hamburger | logo | actions — pecannbee-aligned mobile
              layout. Logo absolute-centered on mobile, normal flex on md+. */}
          <div className="relative flex items-center justify-between h-32 overflow-hidden gap-4 md:h-44">
            {/* Logo — centered on mobile (pecannbee target), normal flex
                on md+. Bumped mobile to h-20 per Ahmad 2026-05-16. */}
            <Link
              href={urlPrefix || '/'}
              className="absolute left-1/2 -translate-x-1/2 md:relative md:left-auto md:translate-x-0 flex items-center justify-center gap-3 shrink-0 cursor-pointer max-w-[65%] md:max-w-none"
            >
              {displayLogo ? (
                <StoreLogo src={displayLogo} alt={displayName} priority invert />
              ) : (
                <span
                  className="text-xl font-black ui-caps-toggle tracking-wider text-white"
                  data-zone="storeName"
                >
                  {displayName}
                </span>
              )}
            </Link>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-1">
              {navigation.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="relative px-4 py-2 text-lg font-bold ui-caps-toggle tracking-wider text-white/70 hover:text-white transition-colors duration-200 group cursor-pointer"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                  <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-primary scale-x-0 group-hover:scale-x-100 transition-transform duration-200 origin-left" />
                </Link>
              ))}
            </nav>

            {/* Actions */}
            <div className="flex items-center gap-2">
              {/* Desktop-only search toggle. Mobile has a persistent search
                  bar below the logo row (pecannbee target). */}
              <button
                onClick={() => setIsSearchOpen(!isSearchOpen)}
                className="hidden md:inline-flex h-11 w-11 items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
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
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </button>

              {/* Language toggle */}
              <LanguageSwitcher
                variant="compact"
                className="text-white/70 hover:text-white hover:bg-white/10"
              />

              {/* Account */}
              <Link
                href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
                className="hidden md:inline-flex h-11 w-11 items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
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
                    strokeWidth={2}
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
              </Link>

              {/* Cart */}
              <Link
                href={`${urlPrefix}/cart`}
                className="relative hidden md:inline-flex h-11 w-11 items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
                aria-label={isRtl ? `سلة (${cartItemCount})` : `Cart (${cartItemCount})`}
              >
                <CartIcon className="w-5 h-5" aria-hidden="true" />
                {cartItemCount > 0 && (
                  <span
                    className={`absolute -top-0.5 -end-0.5 bg-primary text-primary-foreground text-[10px] font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 transition-transform duration-200 ${cartPulse ? 'scale-125' : 'scale-100'}`}
                  >
                    {cartItemCount > 99 ? '99+' : cartItemCount}
                  </span>
                )}
              </Link>

              {/* Mobile Menu */}
              <button
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
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
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Mobile persistent search bar — pecannbee target. Always visible
              under the logo row on mobile, hidden on md+. */}
          <div className="hidden pb-3 border-t border-white/10 pt-3" data-zone="mobile-search">
            <form onSubmit={handleSearch} className="relative">
              <svg
                className="absolute top-1/2 -translate-y-1/2 start-3 w-5 h-5 text-white/50 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'بحث' : 'Search'}
                className="w-full ps-11 pe-4 py-3 bg-white/10 text-white placeholder:text-white/40 rounded-lg border border-white/20 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-base sm:text-sm font-medium transition-colors duration-200"
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

          {/* Desktop expandable search bar — md+ only, toggled via the
              search icon in the actions row. */}
          <div
            className={`hidden md:block overflow-visible transition-[max-height,opacity,padding,border-width] duration-200 ${isSearchOpen ? 'max-h-20 opacity-100 py-3 border-t border-white/10' : 'max-h-0 opacity-0 py-0 pointer-events-none'}`}
          >
            <form onSubmit={handleSearch} className="relative flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'ابحث...' : 'Search products...'}
                className="min-w-0 flex-1 px-4 py-2.5 bg-white/10 text-white placeholder:text-white/40 rounded-lg border border-white/20 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-base sm:text-sm font-medium transition-colors duration-200"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus={isSearchOpen}
                aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
              />
              <button
                type="submit"
                className="px-5 py-2.5 bg-primary text-primary-foreground rounded-lg font-black ui-caps-toggle tracking-wider text-sm hover:bg-primary/80 transition-colors duration-200 cursor-pointer"
              >
                {isRtl ? 'بحث' : 'Go'}
              </button>
              <SearchAutocomplete
                query={searchQuery}
                onSelect={() => {
                  setSearchQuery('');
                  setIsSearchOpen(false);
                }}
              />
            </form>
          </div>
        </div>
      </header>

      {/* Mobile Menu Overlay — item 5 (2026-07-12): shared enter/exit curve
          (220ms in / 160ms out, motion-safe via motion-reduce:duration-0). */}
      <div
        className={`fixed inset-0 z-40 md:hidden transition-opacity ease-out motion-reduce:duration-0 ${isMenuOpen ? 'opacity-100 pointer-events-auto duration-[220ms]' : 'opacity-0 pointer-events-none duration-[160ms]'}`}
        onClick={() => setIsMenuOpen(false)}
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* Mobile Menu Drawer — capped at 320px so on a 320px screen the
          overlay still has a touch-target outside the panel for dismiss.
          Item 5 (2026-07-12): same enter/exit curve as the overlay above. */}
      <div
        className={`fixed top-0 end-0 z-50 h-full w-[85vw] max-w-xs bg-gray-950 border-s border-white/10 md:hidden transition-transform ease-out motion-reduce:duration-0 overscroll-contain ${isMenuOpen ? 'translate-x-0 duration-[220ms]' : isRtl ? '-translate-x-full duration-[160ms]' : 'translate-x-full duration-[160ms]'}`}
        aria-label={isRtl ? 'قائمة التنقل' : 'Navigation menu'}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <span className="font-black ui-caps-toggle tracking-wider text-white text-sm">
            {isRtl ? 'القائمة' : 'Menu'}
          </span>
          <button
            onClick={() => setIsMenuOpen(false)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
            aria-label={isRtl ? 'إغلاق' : 'Close menu'}
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
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <nav className="p-4 flex flex-col gap-1" dir={isRtl ? 'rtl' : 'ltr'}>
          {navigation.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="px-4 py-3 text-lg font-bold ui-caps-toggle tracking-wider text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition-colors duration-200 cursor-pointer"
              onClick={() => setIsMenuOpen(false)}
            >
              {isRtl && item.labelAr ? item.labelAr : item.label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
