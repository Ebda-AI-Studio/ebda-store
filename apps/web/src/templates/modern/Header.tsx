'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { HeaderProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';

export default function ModernHeader({
  branding,
  navigation = [],
  isRtl: isRtlProp,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
  urlPrefix = '',
}: HeaderProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
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
        className={`sticky top-0 z-50 bg-white/80 dark:bg-gray-900/80 backdrop-blur-lg border-b border-border/60 transition-shadow duration-200 ${isScrolled ? 'shadow-sm' : 'shadow-none'}`}
      >
        <div className="container mx-auto px-4">
          <div className="flex h-24 items-center justify-between gap-4 sm:h-28">
            {/* Logo */}
            <Link href={urlPrefix || '/'} className="flex items-center gap-2 shrink-0">
              {displayLogo ? (
                <Image
                  src={displayLogo}
                  alt={displayName}
                  width={320}
                  height={120}
                  className="h-20 max-h-20 w-auto object-contain sm:h-24 sm:max-h-24"
                  priority
                />
              ) : (
                <span className="text-xl font-bold text-primary">{displayName}</span>
              )}
            </Link>

            {/* Desktop Navigation */}
            <nav className={`hidden md:flex items-center gap-1 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {navigation.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="px-3 py-2 text-sm font-medium text-foreground/70 hover:text-foreground hover:bg-muted rounded-lg transition-colors duration-200"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                </Link>
              ))}
            </nav>

            {/* Actions */}
            <div className={`flex items-center gap-1 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {/* Search Button */}
              <button
                type="button"
                onClick={() => setIsSearchOpen(!isSearchOpen)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-200 cursor-pointer"
                aria-label={isRtl ? 'بحث' : 'Search'}
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

              {/* Account */}
              <Link
                href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-200"
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
                className="relative inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-200"
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
                    strokeWidth={2}
                    d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                  />
                </svg>
                {cartItemCount > 0 && (
                  <span
                    className={`absolute -top-0.5 ${isRtl ? '-left-0.5' : '-right-0.5'} bg-primary text-primary-foreground text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 transition-transform duration-200 ${cartPulse ? 'scale-125' : 'scale-100'}`}
                  >
                    {cartItemCount > 99 ? '99+' : cartItemCount}
                  </span>
                )}
              </Link>

              {/* Mobile Menu Button */}
              <button
                type="button"
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-200 cursor-pointer"
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

          {/* Search Bar (Expandable) */}
          <div
            className={`overflow-hidden transition-all duration-300 ${isSearchOpen ? 'max-h-20 opacity-100 py-3 border-t border-border/60' : 'max-h-0 opacity-0 py-0'}`}
          >
            <form onSubmit={handleSearch} className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'ابحث عن المنتجات...' : 'Search products...'}
                className="flex-1 px-4 py-2.5 bg-muted rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm transition-colors duration-200"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus={isSearchOpen}
                aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
              />
              <button
                type="submit"
                className="px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors duration-200 font-medium text-sm cursor-pointer"
              >
                {isRtl ? 'بحث' : 'Search'}
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Mobile Menu Overlay */}
      <div
        className={`fixed inset-0 z-40 md:hidden transition-all duration-300 ${isMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setIsMenuOpen(false)}
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      </div>

      {/* Mobile Menu Drawer — capped at 320px so on a 320px screen the
          overlay still has a touch-target outside the panel for dismiss. */}
      <div
        className={`fixed top-0 ${isRtl ? 'left-0' : 'right-0'} z-50 h-full w-[85vw] max-w-xs bg-background shadow-2xl md:hidden transition-transform duration-300 ease-in-out overscroll-contain ${isMenuOpen ? 'translate-x-0' : isRtl ? '-translate-x-full' : 'translate-x-full'}`}
        aria-label={isRtl ? 'قائمة التنقل' : 'Navigation menu'}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <span className="font-semibold text-foreground">{isRtl ? 'القائمة' : 'Menu'}</span>
          <button
            type="button"
            onClick={() => setIsMenuOpen(false)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted transition-colors duration-200 cursor-pointer"
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
              className="px-4 py-3 text-sm font-medium text-foreground/80 hover:text-foreground hover:bg-muted rounded-lg transition-colors duration-200"
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
