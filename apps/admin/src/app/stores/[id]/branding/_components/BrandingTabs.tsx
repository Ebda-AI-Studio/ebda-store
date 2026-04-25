'use client';

import { useRef, type KeyboardEvent } from 'react';
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
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function focusIndex(idx: number) {
    const clamped = ((idx % TABS.length) + TABS.length) % TABS.length;
    buttonRefs.current[clamped]?.focus();
    const next = TABS[clamped];
    if (next && next.id !== activeTab) onTabChange(next.id);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusIndex(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusIndex(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusIndex(TABS.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div role="tablist" aria-label={t('ariaLabel')} className="flex gap-2 border-b border-border">
      {TABS.map((tab, index) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            ref={el => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={e => handleKeyDown(e, index)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(tab.key)}
          </button>
        );
      })}
    </div>
  );
}
