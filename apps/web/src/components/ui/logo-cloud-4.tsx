'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { InfiniteSlider } from '@/components/ui/infinite-slider';
import { ProgressiveBlur } from '@/components/ui/progressive-blur';

export type Logo = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
};

export type LogoCloudProps = React.ComponentProps<'div'> & {
  logos: Logo[];
};

export function LogoCloud({ logos, className, ...rest }: LogoCloudProps) {
  return (
    <div
      className={cn(
        'relative mx-auto w-full max-w-3xl overflow-hidden',
        'bg-gradient-to-r from-secondary via-transparent to-secondary',
        className
      )}
      {...rest}
    >
      <InfiniteSlider gap={48} duration={30} direction="horizontal">
        {logos.map(logo => (
          <div key={logo.alt} className="flex shrink-0 items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logo.src}
              alt={logo.alt}
              width={logo.width ?? 120}
              height={logo.height ?? 40}
              className="h-4 w-auto md:h-5 dark:brightness-0 dark:invert object-contain"
            />
          </div>
        ))}
      </InfiniteSlider>

      {/* Left progressive blur edge */}
      <ProgressiveBlur
        direction="left"
        blurLayers={6}
        blurIntensity={0.2}
        className="absolute inset-y-0 left-0 w-24"
      />

      {/* Right progressive blur edge */}
      <ProgressiveBlur
        direction="right"
        blurLayers={6}
        blurIntensity={0.2}
        className="absolute inset-y-0 right-0 w-24"
      />
    </div>
  );
}
