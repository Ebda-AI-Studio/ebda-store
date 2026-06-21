import type { Metadata } from 'next';
import { HeroSection } from '@/components/landing/HeroSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
import { BeforeAfterSection } from '@/components/landing/BeforeAfterSection';
import { TestimonialsSection } from '@/components/landing/TestimonialsSection';
import { ClientsSection } from '@/components/landing/ClientsSection';
import ButtonsSection from '@/components/landing/ButtonsSection';
import CtaSection from '@/components/landing/CtaSection';
import { FooterSection } from '@/components/landing/FooterSection';

/**
 * Isolated preview of the redesigned Force AI platform landing.
 *
 * Lives at /landing-preview so the live landing (PlatformLanding.tsx, served at
 * the platform root) is never broken mid-build. Sections are assembled from the
 * 21st.dev component set, recolored to the Force brand (orange/white/black/grey).
 * Swap into page.tsx / PlatformLanding only after Ahmad signs off.
 *
 * noindex — this is a work-in-progress preview, not canonical content.
 */
export const metadata: Metadata = {
  title: 'Force AI — Landing Preview',
  robots: { index: false, follow: false },
};

export default function LandingPreviewPage() {
  return (
    <main className="bg-black">
      <HeroSection />
      <FeaturesSection />
      <BeforeAfterSection />
      <ButtonsSection />
      <TestimonialsSection />
      <ClientsSection />
      <CtaSection />
      <FooterSection />
    </main>
  );
}
