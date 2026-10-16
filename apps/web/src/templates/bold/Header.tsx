'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { CartIcon } from '@ebda/ui';
import { StoreLogo } from '../shared/StoreLogo';
import type { HeaderProps } from '../types';
import { useTabBarShown, HEADER_MENU_WITH_TAB_BAR_KEEP_SLOT } from '../shared/tab-bar-visibility';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { Sheet } from '../../components/ui/Sheet';
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
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const tabBarShown = useTabBarShown();
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
                  translate="no"
                >
                  {displayName}
                </span>
              )}
            </Link>

            {/* Desktop Navigation */}
            <nav aria-label={t('Main', 'الرئيسية')} className="hidden md:flex items-center gap-1">
              {navigation.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="relative inline-flex min-h-11 items-center whitespace-nowrap px-2 py-2 text-base font-bold ui-caps-toggle tracking-wider text-white/70 lg:px-4 lg:text-lg hover:text-white transition-colors duration-200 group cursor-pointer"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                  <span className="absolute bottom-0 inset-x-2 lg:inset-x-4 h-0.5 bg-primary scale-x-0 group-hover:scale-x-100 transition-transform duration-200 origin-left" />
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
                aria-label={t('Search', 'بحث')}
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
                aria-label={t('Account', 'الحساب')}
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
                aria-label={t(`Cart (${cartItemCount})`, `سلة (${cartItemCount})`)}
              >
                <CartIcon className="w-5 h-5" aria-hidden="true" />
                {cartItemCount > 0 && (
                  <span
                    className={`absolute -top-0.5 -end-0.5 bg-primary text-primary-foreground text-xs font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 transition-transform duration-200 ${cartPulse ? 'scale-125' : 'scale-100'}`}
                  >
                    {cartItemCount > 99 ? '99+' : cartItemCount}
                  </span>
                )}
              </Link>

              {/* Mobile Menu */}
              <button
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className={`md:hidden inline-flex h-11 w-11 items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer ${tabBarShown ? HEADER_MENU_WITH_TAB_BAR_KEEP_SLOT : ''}`}
                aria-label={t('Menu', 'القائمة')}
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
                placeholder={t('Search', 'بحث')}
                className="w-full ps-11 pe-4 py-3 bg-white/10 text-white placeholder:text-white/40 rounded-lg border border-white/20 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-base sm:text-sm font-medium transition-colors duration-200"
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
                placeholder={t('Search products...', 'ابحث...')}
                className="min-w-0 flex-1 px-4 py-2.5 bg-white/10 text-white placeholder:text-white/40 rounded-lg border border-white/20 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-base sm:text-sm font-medium transition-colors duration-200"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus={isSearchOpen}
                aria-label={t('Search products', 'بحث عن المنتجات')}
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

      {/* Mobile menu drawer on the shared Sheet primitive (R-04 fix round): Escape,
          backdrop tap, focus in / trap / return to the hamburger, scroll lock; a
          closed drawer holds no tabbable links. */}
      <Sheet
        open={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        side="end"
        dir={isRtl ? 'rtl' : 'ltr'}
        title={t('Menu', 'القائمة')}
        closeLabel={t('Close menu', 'إغلاق القائمة')}
        className="md:hidden bg-gray-950 text-white border-s border-white/10"
        headerClassName="border-b border-white/10 !py-2"
        titleClassName="font-black ui-caps-toggle tracking-wider text-white text-sm"
        closeClassName="text-white/70 hover:text-white hover:bg-white/10"
        bodyClassName=""
      >
        <nav
          aria-label={t('Menu', 'القائمة')}
          className="p-4 flex flex-col gap-1"
          dir={isRtl ? 'rtl' : 'ltr'}
        >
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
      </Sheet>
    </>
  );
}
