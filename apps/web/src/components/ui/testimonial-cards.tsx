'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import type { PanInfo } from 'motion-dom';

export interface TestimonialCardData {
  id: number;
  testimonial: string;
  author: string;
}

export interface TestimonialCardProps extends TestimonialCardData {
  handleShuffle: () => void;
  position: 'front' | 'middle' | 'back';
}

export function TestimonialCard({
  handleShuffle,
  testimonial,
  position,
  id,
  author,
}: TestimonialCardProps) {
  const isFront = position === 'front';

  const zIndex = position === 'front' ? 2 : position === 'middle' ? 1 : 0;
  const rotate = position === 'front' ? '-6deg' : position === 'middle' ? '0deg' : '6deg';
  const x = position === 'front' ? '0%' : position === 'middle' ? '33%' : '66%';

  function handleDragEnd(_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo): void {
    if (info.offset.x < -150) {
      handleShuffle();
    }
  }

  return (
    <motion.div
      style={{ zIndex }}
      animate={{ rotate, x }}
      drag={isFront}
      dragElastic={0.35}
      dragListener={isFront}
      dragConstraints={{ top: 0, left: 0, right: 0, bottom: 0 }}
      onDragEnd={handleDragEnd}
      transition={{ duration: 0.35 }}
      className={[
        'absolute left-0 top-0 grid h-[450px] w-[350px] select-none place-content-center space-y-6 rounded-2xl border-2 border-border bg-card/40 p-6 shadow-xl backdrop-blur-md',
        isFront ? 'cursor-grab active:cursor-grabbing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <img
        src={`https://i.pravatar.cc/128?img=${id}`}
        alt={`Avatar of ${author}`}
        className="pointer-events-none mx-auto h-32 w-32 rounded-full border-2 border-border bg-muted object-cover"
      />
      <span className="text-center text-lg italic text-muted-foreground">
        &quot;{testimonial}&quot;
      </span>
      <span className="text-center text-sm font-medium text-primary">{author}</span>
    </motion.div>
  );
}
