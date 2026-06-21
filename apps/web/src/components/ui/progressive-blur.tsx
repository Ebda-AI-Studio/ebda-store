'use client';

import { motion } from 'framer-motion';
import type { HTMLMotionProps } from 'framer-motion';
import { cn } from '@/lib/utils';

const GRADIENT_ANGLES: Record<string, string> = {
  top: '180deg',
  right: '270deg',
  bottom: '0deg',
  left: '90deg',
};

export interface ProgressiveBlurProps extends HTMLMotionProps<'div'> {
  direction?: 'top' | 'right' | 'bottom' | 'left';
  blurLayers?: number;
  blurIntensity?: number;
  className?: string;
}

export function ProgressiveBlur({
  direction = 'bottom',
  blurLayers = 8,
  blurIntensity = 0.25,
  className,
  style,
  ...rest
}: ProgressiveBlurProps) {
  const angle = GRADIENT_ANGLES[direction];

  return (
    <div className={cn('pointer-events-none absolute inset-0', className)} aria-hidden>
      {Array.from({ length: blurLayers }).map((_, idx) => {
        const layerIndex = idx + 1;
        const start = ((layerIndex - 1) / blurLayers) * 100;
        const end = (layerIndex / blurLayers) * 100;
        const blur = blurIntensity * layerIndex;

        return (
          <motion.div
            key={idx}
            style={{
              position: 'absolute',
              inset: 0,
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              maskImage: `linear-gradient(${angle}, transparent ${start}%, black ${end}%)`,
              WebkitMaskImage: `linear-gradient(${angle}, transparent ${start}%, black ${end}%)`,
              ...style,
            }}
            {...rest}
          />
        );
      })}
    </div>
  );
}
