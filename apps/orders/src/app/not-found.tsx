'use client';

import Link from 'next/link';
import { BRAND_MARKETING_URL } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * The orders PWA's calm 404: one sentence, a search that opens the orders list with the box focused (the
 * term is typed there, never put in a URL), and the quick links. The HTTP status is Next's 404.
 */
export default function NotFound() {
  const { t } = useLanguage();
  const nf = t.notFound;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold text-foreground">{nf.line}</h1>
        <p className="text-muted-foreground">{nf.hint}</p>
      </div>
      <Link
        href="/orders?focus=search"
        className="flex h-12 items-center rounded-2xl border border-input bg-card px-4 text-muted-foreground"
      >
        {nf.searchOrders}
      </Link>
      <nav aria-label={nf.hint}>
        <ul className="flex flex-wrap gap-2">
          {[
            { href: '/', label: nf.home },
            { href: '/orders', label: nf.orders },
          ].map(l => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="inline-flex min-h-11 items-center rounded-full border border-input px-4 text-sm text-foreground"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <a
        href={BRAND_MARKETING_URL}
        className="text-sm text-muted-foreground underline underline-offset-4"
      >
        {nf.backToSite}
      </a>
    </main>
  );
}
