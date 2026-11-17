import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
// Renamed from the conventional `dynamic` to avoid colliding with the route
// segment config export of the same name below (tenant-cacheable routing,
// Phase 1 — see docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.3/§9).
import nextDynamic from 'next/dynamic';

const SettingsClient = nextDynamic(() => import('./SettingsClient'), {
  loading: () => (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  ),
});

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Account Settings', 'إعدادات الحساب'],
    robots: { index: false, follow: false },
  });
}

export default function SettingsPage() {
  return <SettingsClient />;
}
