'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { HeaderProps } from '../types';

export default function BoldHeader({
  branding,
  navigation = [],
  isRtl = false,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
  urlPrefix = '',
}: HeaderProps) {
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
      <header className="bg-gray-950 text-white sticky top-0 z-50 border-b border-white/10">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16 gap-4">
            {/* Logo */}
            <Link
              href={urlPrefix || '/'}
              className="flex items-center gap-3 shrink-0 cursor-pointer"
            >
              {displayLogo ? (
                <img
                  src={displayLogo}
                  alt={displayName}
                  className="h-14 max-h-14 w-auto brightness-0 invert"
                />
              ) : (
                <span className="text-xl font-black uppercase tracking-wider text-white">
                  {displayName}
                </span>
              )}
            </Link>

            {/* Desktop Navigation */}
            <nav className={`hidden md:flex items-center gap-1 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {navigation.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="relative px-4 py-2 text-sm font-bold uppercase tracking-wider text-white/70 hover:text-white transition-colors duration-200 group cursor-pointer"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                  <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-primary scale-x-0 group-hover:scale-x-100 transition-transform duration-200 origin-left" />
                </Link>
              ))}
            </nav>

            {/* Actions */}
            <div className={`flex items-center gap-2 ${isRtl ? 'flex-row-reverse' : ''}`}>
              {/* Search */}
              <button
                onClick={() => setIsSearchOpen(!isSearchOpen)}
                className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
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

              {/* Account */}
              <Link
                href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
                className="hidden sm:flex p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
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
                className="relative p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
                aria-label={isRtl ? `سلة (${cartItemCount})` : `Cart (${cartItemCount})`}
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
                    className={`absolute -top-0.5 ${isRtl ? '-left-0.5' : '-right-0.5'} bg-primary text-primary-foreground text-[10px] font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 transition-transform duration-200 ${cartPulse ? 'scale-125' : 'scale-100'}`}
                  >
                    {cartItemCount > 99 ? '99+' : cartItemCount}
                  </span>
                )}
              </Link>

              {/* Mobile Menu */}
              <button
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="md:hidden p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
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

          {/* Search Bar */}
          <div
            className={`overflow-hidden transition-all duration-200 ${isSearchOpen ? 'max-h-20 opacity-100 py-3 border-t border-white/10' : 'max-h-0 opacity-0 py-0'}`}
          >
            <form onSubmit={handleSearch} className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'ابحث...' : 'Search products...'}
                className="flex-1 px-4 py-2.5 bg-white/10 text-white placeholder:text-white/40 rounded-lg border border-white/20 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm font-medium transition-colors duration-200"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus={isSearchOpen}
                aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
              />
              <button
                type="submit"
                className="px-5 py-2.5 bg-primary text-primary-foreground rounded-lg font-black uppercase tracking-wider text-sm hover:bg-primary/80 transition-colors duration-200 cursor-pointer"
              >
                {isRtl ? 'بحث' : 'Go'}
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Mobile Menu Overlay */}
      <div
        className={`fixed inset-0 z-40 md:hidden transition-all duration-200 ${isMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setIsMenuOpen(false)}
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* Mobile Menu Drawer */}
      <div
        className={`fixed top-0 ${isRtl ? 'left-0' : 'right-0'} z-50 h-full w-72 bg-gray-950 border-l border-white/10 md:hidden transition-transform duration-200 ease-out ${isMenuOpen ? 'translate-x-0' : isRtl ? '-translate-x-full' : 'translate-x-full'}`}
        aria-label={isRtl ? 'قائمة التنقل' : 'Navigation menu'}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <span className="font-black uppercase tracking-wider text-white text-sm">
            {isRtl ? 'القائمة' : 'Menu'}
          </span>
          <button
            onClick={() => setIsMenuOpen(false)}
            className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors duration-200 cursor-pointer"
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
              className="px-4 py-3 text-sm font-bold uppercase tracking-wider text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition-colors duration-200 cursor-pointer"
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
