'use client';

import * as React from 'react';
import { ImageComparison } from '@/components/ui/image-comparison-slider';

export function BeforeAfterSection() {
  return (
    <section className="bg-black py-24 px-4">
      <div className="max-w-5xl mx-auto flex flex-col items-center gap-10">
        {/* Heading */}
        <div className="text-center space-y-4 max-w-2xl">
          <h2 className="text-4xl md:text-5xl font-bold text-white tracking-tight">
            From bare to brand in minutes
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Force AI reads your catalogue and auto-builds a fully branded storefront — logo,
            palette, typography, and layout — without a designer or a single line of code.
          </p>
        </div>

        {/* Comparison slider */}
        <div className="w-full max-w-4xl rounded-2xl overflow-hidden ring-1 ring-border/30 shadow-2xl">
          <ImageComparison
            beforeImage="https://images.unsplash.com/photo-1557821552-17105176677c?w=1200&q=80"
            afterImage="https://images.unsplash.com/photo-1556742502-ec7c0e9f34b1?w=1200&q=80"
            altBefore="Plain product shelf before Force AI"
            altAfter="Polished branded storefront after Force AI"
          />
        </div>

        {/* Caption */}
        <p className="text-xs text-muted-foreground/60 tracking-wide text-center">
          Drag the handle to reveal the transformation
        </p>
      </div>
    </section>
  );
}
