'use client';

import React from 'react';
import { Store, Sparkles, CreditCard, Calculator, MessageCircle, BarChart3 } from 'lucide-react';
import RadialOrbitalTimeline, { type TimelineItem } from '@/components/ui/radial-orbital-timeline';

const featureData: TimelineItem[] = [
  {
    id: 1,
    title: 'Store Builder',
    date: 'Core',
    content:
      'Fully customizable Arabic-first storefronts with drag-and-drop themes, custom domains, and mobile-ready layouts — no code required.',
    category: 'Storefront',
    icon: Store,
    relatedIds: [2, 6],
    status: 'completed',
    energy: 100,
  },
  {
    id: 2,
    title: 'AI Autofill',
    date: 'AI',
    content:
      'Force AI writes product titles, descriptions, and SEO tags in both Arabic and English from a single prompt — 10× faster cataloguing.',
    category: 'Artificial Intelligence',
    icon: Sparkles,
    relatedIds: [1, 6],
    status: 'completed',
    energy: 90,
  },
  {
    id: 3,
    title: 'Kuwait Payments',
    date: 'Payments',
    content:
      'Native integrations with Tap, MyFatoorah, and Hesabe — local gateways preferred by Kuwaiti shoppers, with KWD as first-class currency.',
    category: 'Payments',
    icon: CreditCard,
    relatedIds: [4, 5],
    status: 'completed',
    energy: 95,
  },
  {
    id: 4,
    title: 'Accounting & Inventory',
    date: 'Operations',
    content:
      'Real-time stock tracking, low-stock alerts, multi-warehouse routing, and a built-in P&L dashboard — no external ERP needed.',
    category: 'Operations',
    icon: Calculator,
    relatedIds: [3, 5],
    status: 'completed',
    energy: 85,
  },
  {
    id: 5,
    title: 'WhatsApp Catalog',
    date: 'Marketing',
    content:
      'Push your live catalog directly to WhatsApp and send targeted broadcast campaigns to customer segments — all from one dashboard.',
    category: 'Marketing',
    icon: MessageCircle,
    relatedIds: [3, 4, 6],
    status: 'completed',
    energy: 88,
  },
  {
    id: 6,
    title: 'Analytics & SEO',
    date: 'Growth',
    content:
      'Page-level SEO controls, structured data, and a real-time analytics dashboard with conversion funnels and revenue attribution.',
    category: 'Growth',
    icon: BarChart3,
    relatedIds: [1, 2, 5],
    status: 'in-progress',
    energy: 72,
  },
];

export default function FeaturesSection() {
  return (
    <section className="w-full bg-black">
      {/* Section heading */}
      <div className="flex flex-col items-center gap-3 pt-20 pb-4 px-4 text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
          Everything your store needs
        </h2>
        <p className="text-muted-foreground text-base sm:text-lg max-w-xl">
          Six battle-tested pillars — built for Kuwait, ready to scale across the Gulf.
        </p>
      </div>

      {/* Orbital timeline */}
      <RadialOrbitalTimeline timelineData={featureData} />
    </section>
  );
}
