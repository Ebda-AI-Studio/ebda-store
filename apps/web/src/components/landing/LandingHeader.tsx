'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { liquidbuttonVariants } from '@/components/ui/liquid-glass-button';

const NAV_LINKS = [
  { label: 'What we do', href: '#features' },
  { label: 'Merchants', href: '#merchants' },
  { label: 'Contact', href: 'https://wa.me/96566740311' },
] as const;

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-50 bg-black/60 backdrop-blur-md border-b border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
        {/* Logo + wordmark */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <img src="/logo.svg" alt="Force AI" className="h-8 w-auto" />
          <span className="font-semibold text-white text-base leading-none">Force AI</span>
        </Link>

        {/* Desktop nav — hidden on mobile */}
        <nav className="hidden md:flex items-center gap-8 flex-1 justify-center">
          {NAV_LINKS.map(link => (
            <a
              key={link.label}
              href={link.href}
              className="text-sm text-white/60 hover:text-white transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* CTA — always visible */}
        <div className="shrink-0">
          <a
            href="https://wa.me/96566740311"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(liquidbuttonVariants({ size: 'lg' }))}
            style={{
              backdropFilter: 'blur(12px) url("#container-glass")',
              WebkitBackdropFilter: 'blur(12px) url("#container-glass")',
              background: 'rgba(255,255,255,0.10)',
              boxShadow: '0 4px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.25)',
            }}
          >
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}
