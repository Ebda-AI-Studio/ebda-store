'use client';

import type { ReactNode } from 'react';
import Image from 'next/image';
import { useT } from '@/i18n/useT';

/**
 * Centered, mobile-first card for the signed-out funnel pages (signup, verify
 * email). Logical (`ps/pe/ms/me`) spacing only, so it mirrors under RTL.
 */
export function PublicShell({
  title,
  subtitle,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Wider card for the multi-step flow. */
  wide?: boolean;
}) {
  const tb = useT('components.brand');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'}`}>
        <div className="mb-6 flex justify-center">
          <Image src="/logo.svg" alt={tb('forceMediaAlt')} width={48} height={41} unoptimized />
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
          <h1 className="text-center text-xl font-bold text-foreground">{title}</h1>
          {subtitle && <p className="mt-1 text-center text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
