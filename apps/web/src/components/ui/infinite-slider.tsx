'use client';

import React, { useRef } from 'react';
import { motion, useMotionValue, useAnimationFrame, useTransform } from 'framer-motion';
import useMeasure from 'react-use-measure';
import { cn } from '@/lib/utils';

export interface InfiniteSliderProps {
  children: React.ReactNode;
  gap?: number;
  duration?: number;
  durationOnHover?: number;
  direction?: 'horizontal' | 'vertical';
  reverse?: boolean;
  className?: string;
}

export function InfiniteSlider({
  children,
  gap = 16,
  duration = 25,
  durationOnHover,
  direction = 'horizontal',
  reverse = false,
  className,
}: InfiniteSliderProps) {
  const [ref, { width, height }] = useMeasure();
  const translation = useMotionValue(0);
  const isHovered = useRef(false);
  const isVertical = direction === 'vertical';

  const childrenArray = React.Children.toArray(children);
  // Duplicate children to create seamless loop
  const items = [...childrenArray, ...childrenArray];

  useAnimationFrame((_, delta) => {
    const activeDuration = isHovered.current && durationOnHover ? durationOnHover : duration;

    const dimension = isVertical ? height : width;
    if (dimension === 0) return;

    // pixels per second based on a single set width/height
    const speed = dimension / activeDuration;
    const moveBy = speed * (delta / 1000);

    const next = reverse ? translation.get() + moveBy : translation.get() - moveBy;

    // Reset when we've scrolled a full single-set worth
    const bound = dimension / 2 + gap / 2;
    if (!reverse && next <= -bound) {
      translation.set(next + bound);
    } else if (reverse && next >= bound) {
      translation.set(next - bound);
    } else {
      translation.set(next);
    }
  });

  const x = useTransform(translation, v => (isVertical ? 0 : v));
  const y = useTransform(translation, v => (isVertical ? v : 0));

  return (
    <div
      className={cn('overflow-hidden', className)}
      onMouseEnter={() => {
        isHovered.current = true;
      }}
      onMouseLeave={() => {
        isHovered.current = false;
      }}
    >
      <motion.div
        ref={ref}
        style={{ x, y }}
        className={cn('flex w-max', isVertical ? 'flex-col' : 'flex-row')}
      >
        {items.map((child, idx) => (
          <div
            key={idx}
            style={
              isVertical
                ? { paddingBottom: idx < items.length - 1 ? gap : 0 }
                : { paddingRight: idx < items.length - 1 ? gap : 0 }
            }
          >
            {child}
          </div>
        ))}
      </motion.div>
    </div>
  );
}
