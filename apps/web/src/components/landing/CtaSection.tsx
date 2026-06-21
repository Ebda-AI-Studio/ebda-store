'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import AnimatedTextCycle from '@/components/ui/animated-text-cycle';
import { MetalButton } from '@/components/ui/liquid-glass-button';

// Dynamically imported so tsparticles never runs on the server.
const SparklesCore = dynamic(() => import('@/components/ui/sparkles').then(m => m.SparklesCore), {
  ssr: false,
});

const CYCLE_WORDS = ['storefront', 'catalog', 'checkout', 'brand', 'growth'];

/**
 * CtaSection
 *
 * Full-width dark section with:
 *  - SparklesCore as an absolute background layer (Force orange particles).
 *  - Radial gradient masks so the sparkles fade at the edges.
 *  - A headline with AnimatedTextCycle cycling through CYCLE_WORDS.
 *  - A primary MetalButton CTA.
 */
export default function CtaSection() {
  return (
    <section className="relative w-full overflow-hidden bg-black px-6 py-32 sm:py-40">
      {/* ------------------------------------------------------------------ */}
      {/* Sparkles background                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          maskImage: 'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
        }}
      >
        <SparklesCore
          id="cta-sparkles"
          className="h-full w-full"
          background="transparent"
          particleColor="#ff6e01"
          particleDensity={80}
          minSize={0.6}
          maxSize={1.6}
          speed={0.8}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Foreground content                                                   */}
      {/* ------------------------------------------------------------------ */}
      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-10 text-center">
        {/* Badge */}
        <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-4 py-1 text-sm font-medium text-primary">
          Powered by Force AI
        </span>

        {/* Headline */}
        <h2 className="text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
          Launch your{' '}
          <AnimatedTextCycle words={CYCLE_WORDS} interval={2800} className="text-primary" /> today
        </h2>

        {/* Sub-copy */}
        <p className="max-w-xl text-lg text-white/60">
          Everything you need to build, sell, and grow — in one beautifully designed platform.
        </p>

        {/* CTA */}
        <div className="flex flex-wrap items-center justify-center gap-4">
          <MetalButton colorVariant="primary" size="xl">
            Get started free
          </MetalButton>
          <MetalButton colorVariant="default" size="xl">
            See a live demo
          </MetalButton>
        </div>

        {/* Social proof line */}
        <p className="text-sm text-white/40">
          No credit card required · Cancel anytime · Live in minutes
        </p>
      </div>
    </section>
  );
}
