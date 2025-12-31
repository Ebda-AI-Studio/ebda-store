'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { HeaderProps } from '../types';

export default function MinimalHeader({
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
    <header className="bg-background">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-20">
          {/* Logo */}
          <Link href="/" className="flex-shrink-0">
            {displayLogo ? (
              <img src={displayLogo} alt={displayName} className="h-6 w-auto" />
            ) : (
              <span className="text-sm tracking-[0.3em] uppercase font-light">{displayName}</span>
            )}
          </Link>

          {/* Desktop Navigation - Centered */}
          <nav className="hidden lg:flex items-center gap-12 absolute left-1/2 -translate-x-1/2">
            {navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-xs tracking-[0.2em] uppercase font-light text-muted-foreground hover:text-foreground transition-colors"
              >
                {isRtl && item.labelAr ? item.labelAr : item.label}
              </Link>
            ))}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-6">
            <button
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Search"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <Link
              href={isLoggedIn ? '/account' : '/auth/login'}
              className="hidden sm:block text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Account"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </Link>
            <Link href="/cart" className="relative text-muted-foreground hover:text-foreground transition-colors" aria-label="Cart">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
              </svg>
              {cartItemCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 text-[10px] font-light">
                  {cartItemCount}
                </span>
              )}
            </Link>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="lg:hidden text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                {isMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Search */}
        {isSearchOpen && (
          <div className="py-8 border-t border-border/50">
            <form onSubmit={handleSearch} className="max-w-md mx-auto">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'بحث...' : 'Search...'}
                className="w-full text-center text-sm tracking-wide bg-transparent border-b border-border focus:outline-none focus:border-foreground pb-2 transition-colors"
                dir={isRtl ? 'rtl' : 'ltr'}
                autoFocus
              />
            </form>
          </div>
        )}

        {/* Mobile Menu */}
        {isMenuOpen && (
          <nav className="lg:hidden py-8 border-t border-border/50">
            <ul className="space-y-6 text-center">
              {navigation.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-xs tracking-[0.2em] uppercase font-light text-muted-foreground hover:text-foreground transition-colors"
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
