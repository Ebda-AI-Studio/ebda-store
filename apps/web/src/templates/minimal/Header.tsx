'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { HeaderProps } from '../types';

export default function MinimalHeader({
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

  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  return (
    <header
      className={`sticky top-0 z-50 bg-background transition-transform duration-300 ease-in-out ${
        isVisible ? 'translate-y-0' : '-translate-y-full'
      }`}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="container mx-auto px-6">
        <div
          className={`flex items-center justify-between py-3 ${isRtl ? 'flex-row-reverse' : ''}`}
        >
          {/* Logo */}
          <Link href={urlPrefix || '/'} className="flex-shrink-0">
            {displayLogo ? (
              <Image
                src={displayLogo}
                alt={displayName}
                width={100}
                height={36}
                className="h-9 max-h-9 w-auto"
              />
            ) : (
              <span className="text-xs tracking-[0.3em] uppercase font-light text-foreground">
                {displayName}
              </span>
            )}
          </Link>

          {/* Desktop nav — centered absolutely */}
          <nav
            className={`hidden lg:flex items-center gap-10 absolute left-1/2 -translate-x-1/2 ${
              isRtl ? 'flex-row-reverse' : ''
            }`}
          >
            {navigation.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[11px] tracking-[0.18em] uppercase font-light text-muted-foreground hover:text-foreground transition-colors duration-200"
              >
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}
          </nav>

          {/* Actions */}
          <div className={`flex items-center gap-5 ${isRtl ? 'flex-row-reverse' : ''}`}>
            {/* Search */}
            <button
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer"
              aria-label={isRtl ? 'بحث' : 'Search'}
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

            {/* Account */}
            <Link
              href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
              className="hidden sm:block text-muted-foreground hover:text-foreground transition-colors duration-200"
              aria-label={isRtl ? 'الحساب' : 'Account'}
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
              className="relative text-muted-foreground hover:text-foreground transition-colors duration-200"
              aria-label={isRtl ? `سلة التسوق (${cartItemCount})` : `Cart (${cartItemCount} items)`}
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
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
              {cartItemCount > 0 && (
                <span
                  className={`absolute -top-1.5 ${isRtl ? '-left-1.5' : '-right-1.5'} text-[9px] font-light text-foreground`}
                >
                  {cartItemCount}
                </span>
              )}
            </Link>

            {/* Mobile hamburger */}
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="lg:hidden text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer"
              aria-label={isRtl ? 'القائمة' : 'Menu'}
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

        {/* Search field — smooth expand */}
        <div
          className={`overflow-hidden transition-all duration-300 ${
            isSearchOpen ? 'max-h-16 opacity-100 pb-4' : 'max-h-0 opacity-0'
          }`}
        >
          <form onSubmit={handleSearch} className="max-w-xs mx-auto">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={isRtl ? 'بحث...' : 'Search...'}
              className="w-full text-center text-xs tracking-wide bg-transparent border-b border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground pb-2 transition-colors duration-200"
              dir={isRtl ? 'rtl' : 'ltr'}
              autoFocus={isSearchOpen}
            />
          </form>
        </div>

        {/* Mobile menu */}
        {isMenuOpen && (
          <nav className="lg:hidden pb-6">
            <ul className="space-y-5 text-center">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-[11px] tracking-[0.18em] uppercase font-light text-muted-foreground hover:text-foreground transition-colors duration-200"
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
