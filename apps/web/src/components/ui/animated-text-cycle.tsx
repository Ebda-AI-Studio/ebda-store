'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export interface AnimatedTextCycleProps {
  words: string[];
  interval?: number;
  className?: string;
}

/**
 * AnimatedTextCycle
 *
 * Cycles through an array of words, measuring each word's rendered width via a
 * hidden div so the container width springs smoothly between words.  Each word
 * animates in/out with blur + vertical slide + opacity via framer-motion's
 * AnimatePresence.
 */
export default function AnimatedTextCycle({
  words,
  interval = 5000,
  className,
}: AnimatedTextCycleProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [widths, setWidths] = React.useState<number[]>([]);
  const measureRef = React.useRef<HTMLDivElement>(null);

  // Measure each word's rendered width once the component mounts.
  React.useEffect(() => {
    if (!measureRef.current) return;

    const measured = words.map(word => {
      if (!measureRef.current) return 0;
      measureRef.current.textContent = word;
      return measureRef.current.getBoundingClientRect().width;
    });

    setWidths(measured);
  }, [words]);

  // Cycle through words on the given interval.
  React.useEffect(() => {
    if (words.length <= 1) return;
    const id = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % words.length);
    }, interval);
    return () => clearInterval(id);
  }, [words.length, interval]);

  const currentWord = words[currentIndex] ?? '';
  const containerWidth = widths[currentIndex] ?? undefined;

  return (
    <>
      {/* Hidden element used only to measure word widths */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className={cn(
          'pointer-events-none fixed left-[-9999px] top-[-9999px] whitespace-nowrap opacity-0',
          className
        )}
      />

      {/* Animated width container */}
      <motion.span
        className="relative inline-block overflow-hidden align-bottom"
        animate={{ width: containerWidth }}
        transition={{ type: 'spring', stiffness: 200, damping: 30 }}
        style={{ display: 'inline-block' }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={currentIndex}
            className={cn('inline-block whitespace-nowrap', className)}
            initial={{ opacity: 0, y: 12, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -12, filter: 'blur(8px)' }}
            transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
          >
            {currentWord}
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </>
  );
}
