'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { HeaderProps } from '../types';

export default function ClassicHeader({
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

  return (
    <header className="bg-background shadow-sm" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Top utility bar */}
      <div className="hidden md:block bg-foreground text-background py-2">
        <div className="container mx-auto px-4 flex items-center justify-between text-xs tracking-wide">
          <span className="font-serif italic opacity-80">
            {isRtl ? 'جودة لا مثيل لها منذ التأسيس' : 'Unmatched Quality Since Establishment'}
          </span>
          <div className={`flex items-center gap-6 ${isRtl ? 'flex-row-reverse' : ''}`}>
            <Link
              href={`${urlPrefix}/contact`}
              className="hover:opacity-70 transition-opacity duration-200"
            >
              {isRtl ? 'اتصل بنا' : 'Contact'}
            </Link>
            <Link
              href={`${urlPrefix}/about`}
              className="hover:opacity-70 transition-opacity duration-200"
            >
              {isRtl ? 'من نحن' : 'About'}
            </Link>
          </div>
        </div>
      </div>

      {/* Main header row */}
      <div className="container mx-auto px-4 py-5">
        <div className="flex items-center justify-between gap-4">
          {/* Mobile menu toggle */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden p-2 cursor-pointer text-foreground hover:text-primary transition-colors duration-200"
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
                className="relative text-sm font-serif tracking-widest uppercase text-foreground/70 hover:text-foreground transition-colors duration-200 after:absolute after:bottom-0 after:left-0 after:w-0 after:h-px after:bg-foreground after:transition-all after:duration-300 hover:after:w-full"
              >
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}
          </nav>

          {/* Logo — centered */}
          <Link href={urlPrefix || '/'} className="flex-shrink-0 mx-auto md:mx-0">
            {displayLogo ? (
              <Image
                src={displayLogo}
                alt={displayName}
                width={130}
                height={60}
                className="h-14 max-h-14 w-auto"
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
                className="relative text-sm font-serif tracking-widest uppercase text-foreground/70 hover:text-foreground transition-colors duration-200 after:absolute after:bottom-0 after:left-0 after:w-0 after:h-px after:bg-foreground after:transition-all after:duration-300 hover:after:w-full"
              >
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}

            {/* Action icons */}
            <div className={`flex items-center gap-4 ${isRtl ? 'flex-row-reverse' : ''}`}>
              <button
                onClick={() => document.getElementById('classic-search-input')?.focus()}
                className="cursor-pointer text-foreground/60 hover:text-foreground transition-colors duration-200"
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
              <Link
                href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
                className="text-foreground/60 hover:text-foreground transition-colors duration-200"
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
                className="relative text-foreground/60 hover:text-foreground transition-colors duration-200 cursor-pointer"
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

          {/* Mobile: action icons */}
          <div className={`flex md:hidden items-center gap-3 ${isRtl ? 'flex-row-reverse' : ''}`}>
            <Link
              href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
              className="text-foreground/60 hover:text-foreground transition-colors duration-200"
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
              className="relative text-foreground/60 hover:text-foreground transition-colors duration-200 cursor-pointer"
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

      {/* Search bar */}
      <div className="hidden md:block border-t border-border/40 py-3">
        <form onSubmit={handleSearch} className="container mx-auto px-4 max-w-md">
          <input
            id="classic-search-input"
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={isRtl ? 'ابحث في مجموعتنا...' : 'Search our collection...'}
            className="w-full py-1.5 px-0 border-b border-border bg-transparent font-serif text-sm text-center text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground transition-colors duration-200"
            dir={isRtl ? 'rtl' : 'ltr'}
            aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
          />
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
                    className="block font-serif tracking-wider uppercase text-sm py-2.5 border-b border-border/20 text-foreground/70 hover:text-foreground transition-colors duration-200"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
            {/* Mobile search */}
            <form onSubmit={handleSearch} className="mt-5">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'بحث...' : 'Search...'}
                className="w-full py-2 px-0 border-b border-border bg-transparent text-sm font-serif text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground transition-colors duration-200"
                dir={isRtl ? 'rtl' : 'ltr'}
                aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
              />
            </form>
          </nav>
        </div>
      )}
    </header>
  );
}
