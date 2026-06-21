'use client';

import React from 'react';
import {
  Sparkles,
  Bot,
  Globe,
  Search,
  CreditCard,
  Calculator,
  MessageCircle,
  Palette,
} from 'lucide-react';
import RadialOrbitalTimeline, { type TimelineItem } from '@/components/ui/radial-orbital-timeline';
import { SectionHeader } from '@/components/landing/SectionHeader';

const featureData: TimelineItem[] = [
  {
    id: 1,
    title: 'AI Autofill — AR & EN',
    date: 'AI',
    content:
      'Upload a photo or type a few words and Force AI writes product names, descriptions, and SEO copy in Arabic and English simultaneously — bidirectional, Arabic-first, and ready to publish in seconds.',
    category: 'Artificial Intelligence',
    icon: Sparkles,
    relatedIds: [2, 3, 4],
    status: 'completed',
    energy: 100,
  },
  {
    id: 2,
    title: 'AEO — Answer Engine Optimization',
    date: 'AI',
    content:
      'Force AI structures your catalog with question-answer schema so ChatGPT, Gemini, and Perplexity recommend your products when shoppers ask AI what to buy — your store becomes the answer, not a search result.',
    category: 'Artificial Intelligence',
    icon: Bot,
    relatedIds: [1, 3, 4],
    status: 'completed',
    energy: 92,
  },
  {
    id: 3,
    title: 'GEO — Generative Engine Optimization',
    date: 'AI',
    content:
      'Auto-publishes llms.txt, citation-ready copy, and structured data so generative search engines cite your store as a primary source — your brand gets quoted, not buried under aggregators.',
    category: 'Artificial Intelligence',
    icon: Globe,
    relatedIds: [1, 2, 4],
    status: 'completed',
    energy: 88,
  },
  {
    id: 4,
    title: 'SEO that writes itself',
    date: 'AI',
    content:
      'Per-product meta titles, alt text, canonical tags, sitemaps, and hreflang for Arabic and English are generated and kept fresh automatically — no plugin, no manual updates, no developer needed.',
    category: 'Artificial Intelligence',
    icon: Search,
    relatedIds: [1, 2, 3],
    status: 'completed',
    energy: 85,
  },
  {
    id: 5,
    title: 'Kuwait payments, connected',
    date: 'Payments',
    content:
      'Tap, MyFatoorah, Hesabe, and UPayments are wired in out of the box — KNET and cards work on day one, with KWD as the first-class currency and no third-party checkout redirects.',
    category: 'Payments',
    icon: CreditCard,
    relatedIds: [6, 7],
    status: 'completed',
    energy: 80,
  },
  {
    id: 6,
    title: 'Accounting & inventory',
    date: 'Ops',
    content:
      'Double-entry books, real-time stock levels, P&L, tax reports, and multi-warehouse routing are built directly into your store — no spreadsheets, no external ERP, no manual reconciliation.',
    category: 'Operations',
    icon: Calculator,
    relatedIds: [5, 7],
    status: 'completed',
    energy: 78,
  },
  {
    id: 7,
    title: 'WhatsApp catalog & broadcasts',
    date: 'Marketing',
    content:
      'Your live product catalog syncs to a native WhatsApp catalog automatically, and you can broadcast targeted offers to customer segments — all from the same dashboard you manage orders on.',
    category: 'Marketing',
    icon: MessageCircle,
    relatedIds: [5, 6],
    status: 'in-progress',
    energy: 70,
  },
  {
    id: 8,
    title: 'Smart customization',
    date: 'Design',
    content:
      'A Smart Palette generates a full brand color system from a single color pick, and a page builder lets you tune every section, font, and layout to your brand in seconds — no code, no designer.',
    category: 'Design',
    icon: Palette,
    relatedIds: [5, 6],
    status: 'completed',
    energy: 82,
  },
];

export default function FeaturesSection() {
  return (
    <section id="features" className="w-full bg-black py-20 md:py-28">
      {/* Section heading */}
      <div className="px-4">
        <SectionHeader
          kicker="AI-NATIVE COMMERCE"
          title="Your store, run by AI"
          subtitle="Force AI handles the writing, the search visibility, the books, and the payments — so Kuwaiti merchants can focus on what they sell, not how to manage it."
        />
      </div>

      {/* Orbital timeline */}
      <RadialOrbitalTimeline timelineData={featureData} />
    </section>
  );
}
