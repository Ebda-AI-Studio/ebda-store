'use client';

import * as React from 'react';
import { Button, LiquidButton, MetalButton } from '@/components/ui/liquid-glass-button';

/**
 * ButtonsSection
 *
 * A dark showcase section that demos all three button styles:
 *  - LiquidButton  — frosted-glass effect, brand-neutral
 *  - MetalButton   — gradient metallic, Force orange primary variant
 *  - Button        — standard shadcn-style utility button
 */
export default function ButtonsSection() {
  return (
    <section className="w-full bg-black px-6 py-24">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-12 text-center">
        {/* Heading */}
        <div className="flex flex-col gap-3">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl">
            One platform, every action
          </h2>
          <p className="text-lg text-white/60">
            From launch to scale — everything you need in one place.
          </p>
        </div>

        {/* Button row */}
        <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
          <LiquidButton size="xl">Start free</LiquidButton>

          <MetalButton colorVariant="primary" size="xl">
            Book a demo
          </MetalButton>

          <Button
            variant="outline"
            size="lg"
            className="border-white/20 text-white hover:bg-white/10 hover:text-white"
          >
            Learn more
          </Button>
        </div>
      </div>
    </section>
  );
}
