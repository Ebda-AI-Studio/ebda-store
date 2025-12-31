'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { HeaderProps } from '../types';

export default function BoldHeader({
  branding,
  navigation = [],
  isRtl = false,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
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
    <header className="bg-foreground text-background sticky top-0 z-50">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3">
            {displayLogo ? (
              <img src={displayLogo} alt={displayName} className="h-8 w-auto brightness-0 invert" />
            ) : (
              <span className="text-xl font-black tracking-tight">{displayName}</span>
            )}
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            {navigation.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className="px-4 py-2 text-sm font-bold uppercase tracking-wider rounded-full hover:bg-primary hover:text-primary-foreground transition-colors"
              >
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="p-2 rounded-full hover:bg-primary hover:text-primary-foreground transition-colors"
              aria-label="Search"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </button>
            <Link
              href={isLoggedIn ? '/account' : '/auth/login'}
              className="hidden sm:flex p-2 rounded-full hover:bg-primary hover:text-primary-foreground transition-colors"
              aria-label="Account"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            </Link>
            <Link
              href="/cart"
              className="relative p-2 rounded-full bg-primary text-primary-foreground hover:bg-primary/80 transition-colors"
              aria-label="Cart"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
              {cartItemCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-background text-foreground text-xs font-black w-5 h-5 rounded-full flex items-center justify-center">
                  {cartItemCount}
                </span>
              )}
            </Link>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="md:hidden p-2 rounded-full hover:bg-primary hover:text-primary-foreground transition-colors"
              aria-label="Menu"
            >
              {isMenuOpen ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Search */}
        {isSearchOpen && (
          <div className="py-4 border-t border-background/20">
            <form onSubmit={handleSearch} className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'ابحث...' : 'Search...'}
                className="flex-1 px-4 py-3 bg-background text-foreground rounded-full font-bold focus:outline-none focus:ring-4 focus:ring-primary"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus
              />
              <button
                type="submit"
                className="px-6 py-3 bg-primary text-primary-foreground rounded-full font-bold uppercase tracking-wider hover:bg-primary/80 transition-colors"
              >
                {isRtl ? 'بحث' : 'Go'}
              </button>
            </form>
          </div>
        )}

        {/* Mobile Menu */}
        {isMenuOpen && (
          <nav className="md:hidden py-4 border-t border-background/20">
            <ul className="space-y-2">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="block px-4 py-3 text-sm font-bold uppercase tracking-wider rounded-full hover:bg-primary hover:text-primary-foreground transition-colors"
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
