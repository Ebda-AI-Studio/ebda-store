'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { CartIcon } from '@ebda/ui';
import { StoreLogo } from '../shared/StoreLogo';
import type { HeaderProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { Sheet } from '../../components/ui/Sheet';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { SearchAutocomplete } from '../../components/SearchAutocomplete';

export default function ModernHeader({
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
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [prevCartCount, setPrevCartCount] = useState(cartItemCount);
  const [cartPulse, setCartPulse] = useState(false);

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (cartItemCount > prevCartCount) {
      setCartPulse(true);
      const t = setTimeout(() => setCartPulse(false), 700);
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
        className={`sticky top-0 z-50 bg-background/85 backdrop-blur-lg border-b border-border/60 transition-shadow duration-200 ${isScrolled ? 'shadow-sm' : 'shadow-none'}`}
        style={headerBgColor ? { backgroundColor: headerBgColor } : undefined}
      >
        <div className="container mx-auto px-4">
          {/* Row 1: hamburger | logo | actions — pecannbee mobile layout.
              h-20 mobile keeps the row compact so it doesn't dominate
              the viewport; desktop stays h-28 for the bigger nav row.
              Logo recentered with a more permissive max-w cap below. */}
          <div className="relative flex h-32 overflow-hidden items-center justify-between gap-2 md:h-44">
            {/* Mobile-only hamburger (LEFT slot). Extracted from the actions
                block so the layout matches the pecannbee + alkahraman target:
                hamburger left, logo center, actions right. */}
            <button
              type="button"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-300 ease-out cursor-pointer"
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

            {/* Logo — centered on mobile (per pecannbee + alkahraman target),
                normal flex item on tablet+. Bumped to h-24 mobile per Ahmad's
                follow-up ('still not bigger'). max-w-[60%] keeps a wide
                wordmark from overlapping the hamburger/actions at very
                small viewports. pointer-events-none on the wrapper while
                making the inner Image clickable would lose the parent
                Link, so instead we let the centered Link share space and
                trust the absolute positioning. */}
            <Link
              href={urlPrefix || '/'}
              className="absolute left-1/2 -translate-x-1/2 md:relative md:left-auto md:translate-x-0 flex items-center justify-center gap-2 shrink-0 max-w-[65%] md:max-w-none"
            >
              {displayLogo ? (
                <StoreLogo src={displayLogo} alt={displayName} priority />
              ) : (
                <span className="text-xl font-bold text-primary" data-zone="storeName">
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
                  className="px-4 py-2.5 text-lg font-medium tracking-tight text-foreground/75 hover:text-foreground hover:bg-muted rounded-lg transition-colors duration-300 ease-out"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                </Link>
              ))}
            </nav>

            {/* Actions */}
            <div className="flex items-center gap-1">
              {/* Search Button — desktop-only. On mobile the search bar is
                  always visible as its own row below this one (pecannbee
                  target layout), so the toggle button there would be
                  redundant. */}
              <button
                type="button"
                onClick={() => setIsSearchOpen(!isSearchOpen)}
                className="hidden md:inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-300 ease-out cursor-pointer"
                aria-label={t('Search', 'بحث')}
                aria-expanded={isSearchOpen}
              >
                {isSearchOpen ? (
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
                ) : (
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
                )}
              </button>

              {/* Language toggle */}
              <LanguageSwitcher variant="compact" />

              {/* Account — desktop only. Mobile UX puts account access
                  inside the hamburger drawer; surfacing the icon here
                  on a 320px viewport eats the room the centered logo
                  needs to be readable. */}
              <Link
                href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
                className="hidden md:inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-300 ease-out"
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
                className="relative hidden md:inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-300 ease-out"
                aria-label={t(`Cart (${cartItemCount} items)`, `سلة التسوق (${cartItemCount})`)}
              >
                <CartIcon className="w-5 h-5" aria-hidden="true" />
                {cartItemCount > 0 && (
                  <span
                    className={`absolute -top-0.5 -end-0.5 bg-primary text-primary-foreground text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 transition-transform duration-200 ${cartPulse ? 'scale-125' : 'scale-100'}`}
                  >
                    {cartItemCount > 99 ? '99+' : cartItemCount}
                  </span>
                )}
              </Link>
            </div>
          </div>

          {/* Mobile Row 2: persistent search bar under the logo row (pecannbee
              target layout). Always visible on mobile, hidden on md+ where
              the expandable search-toggle handles it instead.

              Inline magnifying-glass icon on the start side mirrors the
              pecannbee pill shape — single icon-in-input, no separate
              submit button on mobile (form still submits on Enter). */}
          <div className="hidden pb-3 border-t border-border/40 pt-3" data-zone="mobile-search">
            <form onSubmit={handleSearch} className="relative">
              <svg
                className="absolute top-1/2 -translate-y-1/2 start-3 w-5 h-5 text-muted-foreground pointer-events-none"
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
                placeholder={t('Search', 'ابحث...')}
                className="w-full ps-11 pe-4 py-3 bg-muted rounded-full border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-base sm:text-sm transition-colors duration-300 ease-out"
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

          {/* Desktop Search Bar (Expandable) — md+ only, triggered by the
              search-toggle icon in the actions row above. */}
          <div
            className={`hidden md:block overflow-visible transition-[max-height,opacity,padding,border-width] duration-300 ${isSearchOpen ? 'max-h-20 opacity-100 py-3 border-t border-border/60' : 'max-h-0 opacity-0 py-0 pointer-events-none'}`}
          >
            <form onSubmit={handleSearch} className="relative flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('Search products...', 'ابحث عن المنتجات...')}
                className="min-w-0 flex-1 px-4 py-2.5 bg-muted rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-base sm:text-sm transition-colors duration-300 ease-out"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus={isSearchOpen}
                aria-label={t('Search products', 'بحث عن المنتجات')}
              />
              <button
                type="submit"
                className="px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors duration-300 ease-out font-medium text-sm cursor-pointer"
              >
                {isRtl ? 'بحث' : 'Search'}
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
        className="md:hidden bg-background text-foreground"
        headerClassName="border-b border-border !py-2"
        titleClassName="font-semibold text-foreground"
        closeClassName="text-muted-foreground hover:text-foreground hover:bg-muted"
        bodyClassName=""
      >
        <nav className="p-4 flex flex-col gap-1" dir={isRtl ? 'rtl' : 'ltr'}>
          {navigation.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="px-4 py-3 text-lg font-medium text-foreground/80 hover:text-foreground hover:bg-muted rounded-lg transition-colors duration-300 ease-out"
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
