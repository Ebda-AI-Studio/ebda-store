'use client';

import { useT } from '@/i18n/useT';
import type { InventoryTab } from './types';

interface InventoryTabsProps {
  activeTab: InventoryTab;
  alertsCount: number;
  onTabChange: (tab: InventoryTab) => void;
}

const TABS: InventoryTab[] = ['products', 'history', 'alerts'];

/**
 * Tab selector for products / history / alerts. Shows an alert badge
 * with the active alert count on the alerts tab.
 */
export function InventoryTabs({ activeTab, alertsCount, onTabChange }: InventoryTabsProps) {
  const t = useT('inventory.tabs');

  return (
    <div className="flex gap-2 mb-6">
      {TABS.map(tab => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className={`px-4 py-2 rounded-lg font-medium transition-colors relative ${
            activeTab === tab
              ? 'bg-primary text-white'
              : 'bg-muted text-foreground hover:bg-muted/80'
          }`}
        >
          {t(tab)}
          {tab === 'alerts' && alertsCount > 0 && (
            <span className="absolute -top-1 -end-1 w-5 h-5 bg-destructive text-white text-xs rounded-full flex items-center justify-center">
              {alertsCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
