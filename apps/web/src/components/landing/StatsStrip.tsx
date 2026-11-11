'use client';

import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from 'framer-motion';
import { Reveal } from '@/components/landing/Reveal';
import { useLanguage } from '@/contexts/LanguageContext';

function CountUp({
  to,
  suffix = '',
  duration = 1.6,
}: {
  to: number;
  suffix?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const reduce = useReducedMotion();
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setN(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / (duration * 1000));
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Math.round(to * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to, duration, reduce]);

  return (
    <span ref={ref}>
      {n.toLocaleString('en-US')}
      {suffix}
    </span>
  );
}

interface StatItem {
  value: number;
  suffix: string;
  labelEn: string;
  labelAr: string;
}

/** The "200+" marketing suffix (not a signed value). */
const PLUS_SUFFIX = '+';

const STATS: StatItem[] = [
  { value: 200, suffix: PLUS_SUFFIX, labelEn: 'products imported', labelAr: 'منتج مستورد' },
  { value: 2, suffix: '', labelEn: 'languages, AR + EN', labelAr: 'لغتان، عربي + إنجليزي' },
  { value: 7, suffix: '', labelEn: 'days to launch', labelAr: 'أيام للإطلاق' },
];

export function StatsStrip() {
  const { t } = useLanguage();

  return (
    <section id="stats" className="w-full bg-[#0b0a09] border-y border-white/10 py-12">
      <Reveal>
        <div className="mx-auto max-w-5xl px-4">
          <div className="grid grid-cols-2 gap-y-10 md:grid-cols-4">
            {STATS.map(stat => (
              <div key={stat.labelEn} className="flex flex-col items-center text-center">
                <p className="text-4xl md:text-5xl font-bold text-primary">
                  <CountUp to={stat.value} suffix={stat.suffix} />
                </p>
                <p className="mt-2 text-sm text-white/60">{t(stat.labelEn, stat.labelAr)}</p>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
