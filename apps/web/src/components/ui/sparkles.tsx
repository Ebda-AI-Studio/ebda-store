'use client';

import * as React from 'react';
import { useAnimation } from 'framer-motion';
import { motion } from 'framer-motion';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import type { Container, ISourceOptions } from '@tsparticles/engine';
import { cn } from '@/lib/utils';

export interface SparklesCoreProps {
  id?: string;
  className?: string;
  background?: string;
  minSize?: number;
  maxSize?: number;
  speed?: number;
  /** Default: Force orange #ff6e01 */
  particleColor?: string;
  particleDensity?: number;
}

export function SparklesCore({
  id = 'tsparticles',
  className,
  background = 'transparent',
  minSize = 0.6,
  maxSize = 1.4,
  speed = 1,
  particleColor = '#ff6e01',
  particleDensity = 120,
}: SparklesCoreProps) {
  const [init, setInit] = React.useState(false);
  const controls = useAnimation();

  React.useEffect(() => {
    initParticlesEngine(async engine => {
      await loadSlim(engine);
    }).then(() => {
      setInit(true);
    });
  }, []);

  const particlesLoaded = React.useCallback(
    async (container?: Container) => {
      // Only fade the layer in once tsparticles reports a live container.
      if (!container) return;
      await controls.start({
        opacity: 1,
        transition: { duration: 1 },
      });
    },
    [controls]
  );

  const options: ISourceOptions = React.useMemo(
    () => ({
      background: { color: { value: background } },
      fullScreen: { enable: false, zIndex: 1 },
      fpsLimit: 60,
      interactivity: {
        events: {
          onClick: { enable: true, mode: 'push' },
          onHover: { enable: false, mode: 'repulse' },
          resize: { enable: true },
        },
        modes: {
          push: { quantity: 4 },
          repulse: { distance: 200, duration: 0.4 },
        },
      },
      particles: {
        bounders: {},
        color: { value: particleColor },
        links: {
          color: particleColor,
          distance: 150,
          enable: false,
          opacity: 0.4,
          width: 1,
        },
        move: {
          direction: 'none' as const,
          enable: true,
          outModes: { default: 'bounce' as const },
          random: true,
          speed: speed,
          straight: false,
        },
        number: {
          density: { enable: true, width: 400, height: 400 },
          value: particleDensity,
        },
        opacity: {
          value: { min: 0.1, max: 0.8 },
          animation: {
            enable: true,
            speed: 1,
            sync: false,
            startValue: 'random' as const,
          },
        },
        shape: { type: 'circle' },
        size: {
          value: { min: minSize, max: maxSize },
          animation: {
            enable: true,
            speed: 2,
            sync: false,
            startValue: 'random' as const,
          },
        },
      },
      detectRetina: true,
    }),
    [background, minSize, maxSize, speed, particleColor, particleDensity]
  );

  if (!init) return null;

  return (
    <motion.div
      animate={controls}
      className={cn('opacity-0', className)}
      style={{ width: '100%', height: '100%' }}
    >
      <Particles
        id={id}
        className="h-full w-full"
        particlesLoaded={particlesLoaded}
        options={options}
      />
    </motion.div>
  );
}
