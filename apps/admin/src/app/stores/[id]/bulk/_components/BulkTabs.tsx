'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useT } from '@/i18n/useT';
import type { BulkTab } from './types';

interface BulkTabsProps {
  activeTab: BulkTab;
  onTabChange: (tab: BulkTab) => void;
}

const TABS: ReadonlyArray<{
  id: BulkTab;
  key: string;
  iconPath: string;
}> = [
  {
    id: 'import',
    key: 'import',
    iconPath: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12',
  },
  {
    id: 'catalog',
    key: 'catalog',
    iconPath:
      'M3 9a2 2 0 012-2h.93a2 2 0 001.66-.9l.82-1.2A2 2 0 0110.07 4h3.86a2 2 0 011.66.9l.82 1.2a2 2 0 001.66.9H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z M15 13a3 3 0 11-6 0 3 3 0 016 0z',
  },
  {
    id: 'export',
    key: 'export',
    iconPath: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
  },
];

/**
 * Top-level tab switch between the import wizard and the export panel.
 * Implements the WAI-ARIA tab pattern with arrow-key navigation.
 */
export function BulkTabs({ activeTab, onTabChange }: BulkTabsProps) {
  const t = useT('bulk.tabs');
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
    <div className="mb-6 border-b">
      <nav role="tablist" aria-label={t('ariaLabel')} className="flex gap-4">
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
              className={`pb-3 max-sm:min-h-11 max-sm:inline-flex max-sm:items-center text-sm font-medium transition ${
                isActive
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={tab.iconPath}
                  />
                </svg>
                {t(tab.key)}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
