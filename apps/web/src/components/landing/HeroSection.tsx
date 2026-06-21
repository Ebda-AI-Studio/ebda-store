'use client';
import dynamic from 'next/dynamic';

// three.js must never hit the SSR bundle — lazy-load client-side only.
const WebGLShader = dynamic(
  () => import('@/components/ui/web-gl-shader').then(m => m.WebGLShader),
  { ssr: false }
);

export function HeroSection() {
  return (
    <section className="relative min-h-screen bg-black overflow-hidden flex items-center justify-center">
      {/* Full-bleed WebGL background — stays inside this section via absolute inset-0 */}
      <WebGLShader />

      {/* Foreground content — above the canvas */}
      <div className="relative z-10 flex items-center justify-center w-full px-4 py-24">
        <div className="max-w-3xl w-full rounded-2xl border border-border/40 bg-background/5 backdrop-blur-md p-10 md:p-16 flex flex-col items-center gap-6 text-center shadow-2xl">
          {/* Available-now indicator. Green is a semantic "available/online"
              status signal on Force's OWN platform landing — this page is not a
              tenant-themed storefront, so the design-token rule (which exists to
              make tenant pages honor the tenant theme) doesn't apply here. */}
          {/* eslint-disable no-restricted-syntax */}
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
            </span>
            <span className="text-xs font-medium text-green-400 tracking-wide uppercase">
              Available now
            </span>
          </div>
          {/* eslint-enable no-restricted-syntax */}

          {/* Headline */}
          <h1 className="text-4xl md:text-7xl font-bold leading-tight tracking-tight text-white">
            Build your store with <span className="text-primary">Force AI</span>
          </h1>

          {/* Sub-headline */}
          <p className="text-base md:text-xl text-muted-foreground max-w-xl leading-relaxed">
            AI-powered e-commerce storefronts built for Kuwait and the Gulf. Launch a fully
            customized online store in minutes — Arabic-first, locally integrated, always smart.
          </p>

          {/* CTA */}
          <button
            type="button"
            className="mt-2 inline-flex items-center justify-center rounded-full bg-primary px-8 h-12 text-sm font-semibold text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            Get started
          </button>
        </div>
      </div>
    </section>
  );
}
