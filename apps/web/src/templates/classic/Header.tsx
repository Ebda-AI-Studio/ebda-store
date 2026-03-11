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

  return (
    <header className="bg-background border-b-2 border-border">
      {/* Top Bar */}
      <div className="hidden md:block bg-foreground text-background py-2">
        <div className="container mx-auto px-4 flex items-center justify-between text-sm">
          <span className="font-serif italic">
            {isRtl ? 'جودة لا مثيل لها منذ التأسيس' : 'Unmatched Quality Since Establishment'}
          </span>
          <div className="flex items-center gap-6">
            <Link href={`${urlPrefix}/contact`} className="hover:text-primary transition-colors">
              {isRtl ? 'اتصل بنا' : 'Contact'}
            </Link>
            <Link href={`${urlPrefix}/about`} className="hover:text-primary transition-colors">
              {isRtl ? 'من نحن' : 'About'}
            </Link>
          </div>
        </div>
      </div>

      {/* Main Header */}
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          {/* Mobile Menu */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden p-2"
            aria-label="Menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>

          {/* Logo - Centered */}
          <Link
            href={urlPrefix || '/'}
            className="absolute left-1/2 -translate-x-1/2 md:static md:translate-x-0"
          >
            {displayLogo ? (
              <Image
                src={displayLogo}
                alt={displayName}
                width={120}
                height={56}
                className="h-14 max-h-14 w-auto"
              />
            ) : (
              <span className="text-2xl font-serif font-bold tracking-wider">{displayName}</span>
            )}
          </Link>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => document.getElementById('classic-search')?.focus()}
              className="hidden md:block"
              aria-label="Search"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              aria-label="Account"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            </Link>
            <Link href={`${urlPrefix}/cart`} className="relative" aria-label="Cart">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
              {cartItemCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-foreground text-background text-xs w-5 h-5 rounded-full flex items-center justify-center font-serif">
                  {cartItemCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="hidden md:block border-t border-border">
        <div className="container mx-auto px-4">
          <ul className="flex items-center justify-center gap-8 py-4">
            {navigation.map(item => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="font-serif text-sm tracking-widest uppercase hover:text-primary transition-colors"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Search Bar */}
      <div className="hidden md:block border-t border-border py-4">
        <form onSubmit={handleSearch} className="container mx-auto px-4 max-w-lg">
          <div className="relative">
            <input
              id="classic-search"
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={isRtl ? 'ابحث في مجموعتنا...' : 'Search our collection...'}
              className="w-full py-2 px-4 border-b-2 border-border bg-transparent font-serif text-center focus:outline-none focus:border-foreground transition-colors"
              dir={isRtl ? 'rtl' : 'ltr'}
            />
          </div>
        </form>
      </div>

      {/* Mobile Menu */}
      {isMenuOpen && (
        <div className="md:hidden border-t border-border py-4">
          <nav className="container mx-auto px-4">
            <ul className="space-y-4">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="block font-serif tracking-wider uppercase py-2"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}
    </header>
  );
}
