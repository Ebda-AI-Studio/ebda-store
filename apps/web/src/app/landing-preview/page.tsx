import type { Metadata } from 'next';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { HeroSection } from '@/components/landing/HeroSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
import { BeforeAfterSection } from '@/components/landing/BeforeAfterSection';
import { AeoGeoSection } from '@/components/landing/AeoGeoSection';
import { MerchantsSection } from '@/components/landing/MerchantsSection';
import CtaSection from '@/components/landing/CtaSection';
import { FooterSection } from '@/components/landing/FooterSection';
import { FloatingWhatsApp } from '@/components/landing/FloatingWhatsApp';

/**
 * Isolated preview of the redesigned Force AI platform landing.
 *
 * Lives at /landing-preview so the live landing (PlatformLanding.tsx) is never
 * touched until sign-off. One cohesive dark site: a sticky header, a WebGL hero,
 * the AI-native feature orbit, real Kuwaiti merchants, a sparkles CTA, and the
 * footer — glued together by the shared SectionHeader (orange hairline) motif,
 * liquid-glass CTAs, and a persistent WhatsApp float.
 *
 * noindex — work-in-progress preview, not canonical content.
 */
export const metadata: Metadata = {
  title: 'Force AI — Landing Preview',
  robots: { index: false, follow: false },
};

export default function LandingPreviewPage() {
  return (
    <main className="bg-black">
      <LandingHeader />
      <HeroSection />
      <FeaturesSection />
      <BeforeAfterSection />
      <AeoGeoSection />
      <MerchantsSection />
      <CtaSection />
      <FooterSection />
      <FloatingWhatsApp />
    </main>
  );
}
