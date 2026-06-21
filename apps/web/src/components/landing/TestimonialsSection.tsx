'use client';

import * as React from 'react';
import { TestimonialCard, type TestimonialCardData } from '@/components/ui/testimonial-cards';

const TESTIMONIALS: TestimonialCardData[] = [
  {
    id: 1,
    testimonial:
      'Since switching to Force AI our online orders doubled in the first month. The Arabic storefront is flawless — customers actually trust it.',
    author: 'Noor Al-Rashidi — Oud & Amber Perfumes, Kuwait City',
  },
  {
    id: 2,
    testimonial:
      'Managing 200+ cake SKUs used to take us all morning. With the AI catalogue tool it is done in minutes. Our Salmiya bakery has never looked more professional online.',
    author: "Fatima Al-Mutairi — Layla's Patisserie, Salmiya",
  },
  {
    id: 3,
    testimonial:
      'The smart palette picked our brand colours perfectly and the storefront looked polished from day one. Our Hawalli boutique went from zero online presence to daily orders.',
    author: 'Sara Al-Enezi — Mirage Fashion Boutique, Hawalli',
  },
];

type Position = 'front' | 'middle' | 'back';
const POSITIONS: Position[] = ['front', 'middle', 'back'];

export function TestimonialsSection() {
  const [order, setOrder] = React.useState<Position[]>([...POSITIONS]);

  function handleShuffle(): void {
    setOrder(prev => {
      const next = [...prev] as Position[];
      const last = next.pop()!;
      next.unshift(last);
      return next;
    });
  }

  return (
    <section className="bg-black py-24 px-4">
      <div className="mx-auto max-w-6xl">
        {/* Heading */}
        <div className="mb-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Loved by Kuwaiti merchants
          </h2>
          <p className="mt-4 text-base text-muted-foreground">
            Real stores. Real results. From Kuwait City to Hawalli.
          </p>
        </div>

        {/* Stack */}
        <div className="flex justify-center">
          {/* Outer container sized to the card + enough room for the shifted back cards */}
          <div className="relative h-[450px] w-[350px] translate-x-[-33%]">
            {TESTIMONIALS.map((card, idx) => (
              <TestimonialCard
                key={card.id}
                {...card}
                position={order[idx]}
                handleShuffle={handleShuffle}
              />
            ))}
          </div>
        </div>

        <p className="mt-12 text-center text-sm text-muted-foreground">
          Drag the front card to the left to see the next review
        </p>
      </div>
    </section>
  );
}
