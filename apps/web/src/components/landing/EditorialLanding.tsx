import { LandingHeader } from '@/components/landing/LandingHeader';
import { HeroSection } from '@/components/landing/HeroSection';
import { StatsStrip } from '@/components/landing/StatsStrip';
import FeaturesSection from '@/components/landing/FeaturesSection';
import { BeforeAfterSection } from '@/components/landing/BeforeAfterSection';
import { AeoGeoSection } from '@/components/landing/AeoGeoSection';
import { MerchantsSection } from '@/components/landing/MerchantsSection';
import CtaSection from '@/components/landing/CtaSection';
import { FooterSection } from '@/components/landing/FooterSection';
import { FloatingWhatsApp } from '@/components/landing/FloatingWhatsApp';
import { LandingNotFoundBanner } from '@/components/landing/LandingNotFoundBanner';
import { Reveal } from '@/components/landing/Reveal';

/**
 * The Force AI platform landing (store.force-ai.co) — editorial dark system:
 * warm near-black + grain, orange as accent/glow only, and a real Force AI
 * client store (Pecannbee) as the hero. Rendered at the bare platform root
 * (`page.tsx`), on the 404 (`not-found.tsx`, with `notFoundBanner`), and at
 * `/landing-preview`. Replaces the old light `PlatformLanding.tsx`.
 */
export function EditorialLanding({ notFoundBanner = false }: { notFoundBanner?: boolean }) {
  return (
    <main className="bg-[#0b0a09]">
      <LandingHeader />
      {notFoundBanner ? <LandingNotFoundBanner /> : null}
      <HeroSection />
      <StatsStrip />
      <Reveal>
        <FeaturesSection />
      </Reveal>
      <Reveal>
        <BeforeAfterSection />
      </Reveal>
      <Reveal>
        <AeoGeoSection />
      </Reveal>
      <Reveal>
        <MerchantsSection />
      </Reveal>
      <Reveal>
        <CtaSection />
      </Reveal>
      <FooterSection />
      <FloatingWhatsApp />
    </main>
  );
}
