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
  { id: 'locations', key: 'locations' },
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
    <div role="tablist" aria-label={t('ariaLabel')} className="flex max-w-full gap-2 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
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
            onFocus={e => e.currentTarget.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })}
            className={`shrink-0 whitespace-nowrap px-4 py-2 max-sm:min-h-11 max-sm:inline-flex max-sm:items-center text-sm font-medium border-b-2 -mb-px transition-colors ${
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
