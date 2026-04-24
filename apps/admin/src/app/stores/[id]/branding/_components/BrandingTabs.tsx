'use client';

import { useT } from '@/i18n/useT';
import type { BrandingTabId } from './types';

interface BrandingTabsProps {
  activeTab: BrandingTabId;
  onTabChange: (tab: BrandingTabId) => void;
}

const TABS: Array<{ id: BrandingTabId; key: string }> = [
  { id: 'branding', key: 'branding' },
  { id: 'theme', key: 'theme' },
  { id: 'contact', key: 'contact' },
  { id: 'social', key: 'social' },
];

export function BrandingTabs({ activeTab, onTabChange }: BrandingTabsProps) {
  const t = useT('branding.tabs');

  return (
    <div className="flex gap-2 border-b border-border">
      {TABS.map(tab => (
        <button
          type="button"
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === tab.id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(tab.key)}
        </button>
      ))}
    </div>
  );
}
