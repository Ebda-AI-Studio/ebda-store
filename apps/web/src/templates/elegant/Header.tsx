'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { HeaderProps } from '../types';

export default function ElegantHeader({
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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && searchQuery.trim()) {
      onSearch(searchQuery);
    }
  };

  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  return (
    <header className="bg-background border-b border-border/30 border-b-2 border-b-primary/20">
      <div className="container mx-auto px-4">
        {/* Top Bar */}
        <div className="hidden md:flex items-center justify-between py-2 text-xs border-b border-border/30">
          <div className="flex items-center gap-6">
            <span className="text-muted-foreground">
              {isRtl ? 'شحن مجاني للطلبات فوق 25 د.ك' : 'Free shipping on orders over 25 KD'}
            </span>
          </div>
          <div className="flex items-center gap-6">
            <Link
              href={`${urlPrefix}/contact`}
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              {isRtl ? 'تواصل معنا' : 'Contact'}
            </Link>
            <Link
              href={`${urlPrefix}/wishlist`}
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              {isRtl ? 'المفضلة' : 'Wishlist'}
            </Link>
          </div>
        </div>

        {/* Main Header */}
        <div className="flex items-center justify-between py-6">
          {/* Mobile Menu */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden"
            aria-label="Menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isMenuOpen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M6 18L18 6M6 6l12 12"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              )}
            </svg>
          </button>

          {/* Desktop Navigation - Left (spacer for centering logo) */}
          <div className="hidden md:flex flex-1" />

          {/* Logo - Center */}
          <Link href={urlPrefix || '/'} className="flex-shrink-0">
            {displayLogo ? (
              <img src={displayLogo} alt={displayName} className="h-14 max-h-14 w-auto" />
            ) : (
              <span className="text-2xl font-light tracking-[0.2em]">{displayName}</span>
            )}
          </Link>

          {/* Actions - Right */}
          <div className="flex items-center gap-6 flex-1 justify-end">
            <button
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="hidden md:block text-muted-foreground hover:text-primary transition-colors"
              aria-label="Search"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </button>
            <Link
              href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
              className="hidden md:block text-muted-foreground hover:text-primary transition-colors"
              aria-label="Account"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            </Link>
            <Link
              href={`${urlPrefix}/cart`}
              className="relative text-muted-foreground hover:text-primary transition-colors"
              aria-label="Cart"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
              {cartItemCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-primary text-primary-foreground text-[10px] w-4 h-4 rounded-full flex items-center justify-center">
                  {cartItemCount}
                </span>
              )}
            </Link>
          </div>
        </div>

        {/* Desktop Navigation - Bottom */}
        <nav className="hidden md:flex items-center justify-center gap-8 pb-4 border-b border-border/30">
          {navigation.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="text-xs tracking-[0.15em] uppercase text-muted-foreground hover:text-primary transition-colors"
            >
              {isRtl && item.labelAr ? item.labelAr : item.label}
            </Link>
          ))}
        </nav>

        {/* Search */}
        {isSearchOpen && (
          <div className="py-6 border-t border-border/30">
            <form onSubmit={handleSearch} className="max-w-lg mx-auto relative">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'ما الذي تبحث عنه؟' : 'What are you looking for?'}
                className="w-full px-0 py-3 bg-transparent border-b border-border focus:outline-none focus:border-primary text-center text-sm tracking-wide transition-colors"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus
              />
            </form>
          </div>
        )}

        {/* Mobile Menu */}
        {isMenuOpen && (
          <nav className="md:hidden py-6 border-t border-border/30">
            <ul className="space-y-4 text-center">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm tracking-[0.1em] uppercase text-muted-foreground hover:text-primary transition-colors"
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
