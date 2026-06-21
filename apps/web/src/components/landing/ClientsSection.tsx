'use client';

import { LogoCloud } from '@/components/ui/logo-cloud-4';
import type { Logo } from '@/components/ui/logo-cloud-4';

const logos: Logo[] = [
  {
    src: 'https://svgl.app/library/vercel_wordmark.svg',
    alt: 'Vercel',
    width: 100,
    height: 24,
  },
  {
    src: 'https://svgl.app/library/github_wordmark_light.svg',
    alt: 'GitHub',
    width: 80,
    height: 24,
  },
  {
    src: 'https://svgl.app/library/cloudflare_wordmark.svg',
    alt: 'Cloudflare',
    width: 110,
    height: 24,
  },
  {
    src: 'https://svgl.app/library/google_cloud.svg',
    alt: 'Google Cloud',
    width: 110,
    height: 24,
  },
  {
    src: 'https://svgl.app/library/visa.svg',
    alt: 'Visa',
    width: 60,
    height: 24,
  },
  {
    src: 'https://svgl.app/library/mastercard.svg',
    alt: 'Mastercard',
    width: 48,
    height: 30,
  },
];

export function ClientsSection() {
  return (
    <section className="bg-black py-16 px-4">
      <div className="mx-auto max-w-3xl text-center mb-10">
        <p className="text-sm text-muted-foreground tracking-wide uppercase mb-2">
          Trusted by stores across Kuwait
        </p>
        <h2 className="text-2xl md:text-3xl font-bold text-primary">Growing every week</h2>
      </div>

      <LogoCloud logos={logos} />

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Built on infrastructure you trust.
      </p>
    </section>
  );
}
