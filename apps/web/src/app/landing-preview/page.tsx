import type { Metadata } from 'next';
import { EditorialLanding } from '@/components/landing/EditorialLanding';
import { BRAND } from '@ebda/shared';

/**
 * Preview alias of the editorial platform landing (now also the live landing at
 * the platform root + 404). Kept as a stable review URL; noindex so it never
 * competes with the canonical root for indexing.
 */
export const metadata: Metadata = {
  title: `${BRAND.product.nameEn} — Landing Preview`,
  robots: { index: false, follow: false },
};

export default function LandingPreviewPage() {
  return <EditorialLanding />;
}
