'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Scroll-reveal wrapper — fades + lifts its children into view the first time
 * they enter the viewport. The single biggest "liveliness" lever for the
 * landing: every section animates in instead of just being there. Honors
 * prefers-reduced-motion (renders static).
 */
export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Ambient animated aurora — two slow-drifting orange/amber blobs behind a dark
 * section, giving the black canvas subtle life. Pointer-events-none, sits at the
 * back. Honors reduced motion (still renders, just not animated).
 */
export function Aurora({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const anim = reduce
    ? {}
    : {
        animate: { x: [0, 30, -20, 0], y: [0, -25, 15, 0], scale: [1, 1.1, 0.95, 1] },
        transition: { duration: 18, repeat: Infinity, ease: 'easeInOut' as const },
      };
  const anim2 = reduce
    ? {}
    : {
        animate: { x: [0, -25, 20, 0], y: [0, 20, -15, 0], scale: [1, 0.9, 1.08, 1] },
        transition: { duration: 22, repeat: Infinity, ease: 'easeInOut' as const },
      };
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}>
      <motion.div
        {...anim}
        className="absolute -left-24 top-0 h-72 w-72 rounded-full bg-primary/20 blur-[100px]"
      />
      <motion.div
        {...anim2}
        className="absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-primary/15 blur-[110px]"
      />
    </div>
  );
}
