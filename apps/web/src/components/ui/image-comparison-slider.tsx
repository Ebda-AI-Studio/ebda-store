'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ImageComparisonProps {
  beforeImage: string;
  afterImage: string;
  altBefore?: string;
  altAfter?: string;
  className?: string;
}

export function ImageComparison({
  beforeImage,
  afterImage,
  altBefore = 'Before',
  altAfter = 'After',
  className,
}: ImageComparisonProps) {
  const [sliderPosition, setSliderPosition] = React.useState<number>(50);
  const [isDragging, setIsDragging] = React.useState<boolean>(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const handleMove = React.useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const clamped = Math.min(Math.max((x / rect.width) * 100, 0), 100);
    setSliderPosition(clamped);
  }, []);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
    handleMove(e.clientX);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    handleMove(e.clientX);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    if (touch) {
      setIsDragging(true);
      handleMove(touch.clientX);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    if (touch) handleMove(touch.clientX);
  };

  React.useEffect(() => {
    const stopDragging = () => setIsDragging(false);
    window.addEventListener('mouseup', stopDragging);
    return () => window.removeEventListener('mouseup', stopDragging);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative w-full overflow-hidden rounded-xl select-none cursor-col-resize',
        className
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => setIsDragging(false)}
    >
      {/* Before image — base layer */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={beforeImage}
        alt={altBefore}
        draggable={false}
        className="block w-full h-full object-cover"
      />

      {/* After image — clipped layer */}
      <div
        className="absolute inset-0"
        style={{
          clipPath: `inset(0 ${100 - sliderPosition}% 0 0)`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={afterImage}
          alt={altAfter}
          draggable={false}
          className="block w-full h-full object-cover"
        />
      </div>

      {/* Divider line */}
      <div
        className="absolute inset-y-0 w-0.5 bg-white/80 shadow-lg"
        style={{ left: `${sliderPosition}%`, transform: 'translateX(-50%)' }}
      />

      {/* Handle */}
      <div
        className={cn(
          'absolute top-1/2 -translate-x-1/2 -translate-y-1/2',
          'flex items-center justify-center',
          'w-10 h-10 rounded-full bg-white shadow-xl',
          'border-2 border-white/90',
          'transition-shadow',
          isDragging ? 'shadow-2xl scale-110' : 'hover:shadow-2xl hover:scale-105'
        )}
        style={{ left: `${sliderPosition}%` }}
        aria-hidden="true"
      >
        {/* Left-right arrows */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-5 h-5 text-gray-700"
          aria-hidden="true"
        >
          <path d="M8 4L4 8l4 4" />
          <path d="M16 4l4 4-4 4" />
          <line x1="4" y1="8" x2="20" y2="8" />
        </svg>
      </div>

      {/* Labels */}
      <div className="absolute bottom-3 left-3 pointer-events-none">
        <span className="text-xs font-semibold uppercase tracking-widest bg-black/60 text-white px-2 py-1 rounded">
          Before
        </span>
      </div>
      <div className="absolute bottom-3 right-3 pointer-events-none">
        <span className="text-xs font-semibold uppercase tracking-widest bg-black/60 text-white px-2 py-1 rounded">
          After
        </span>
      </div>
    </div>
  );
}
