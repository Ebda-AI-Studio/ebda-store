import { LandingHeader } from '@/components/landing/LandingHeader';
import { HeroSection } from '@/components/landing/HeroSection';
import { StatsStrip } from '@/components/landing/StatsStrip';
import FeaturesSection from '@/components/landing/FeaturesSection';
import { BeforeAfterSection } from '@/components/landing/BeforeAfterSection';
import { AeoGeoSection } from '@/components/landing/AeoGeoSection';
import CtaSection from '@/components/landing/CtaSection';
import { FooterSection } from '@/components/landing/FooterSection';
import { LandingNotFoundBanner } from '@/components/landing/LandingNotFoundBanner';
import { Reveal } from '@/components/landing/Reveal';

/**
 * The Ebda platform landing (ebda.app) — editorial dark system:
 * warm near-black + grain, orange as accent/glow only, and an illustrative
 * storefront as the hero. Rendered at the bare platform root
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
        <CtaSection />
      </Reveal>
      <FooterSection />
    </main>
  );
}
