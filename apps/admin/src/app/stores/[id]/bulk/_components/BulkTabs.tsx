'use client';

import { useT } from '@/i18n/useT';
import type { BulkTab } from './types';

interface BulkTabsProps {
  activeTab: BulkTab;
  onTabChange: (tab: BulkTab) => void;
}

/**
 * Top-level tab switch between the import wizard and the export panel.
 * Icons are placed via flex+gap so the layout mirrors cleanly in RTL.
 */
export function BulkTabs({ activeTab, onTabChange }: BulkTabsProps) {
  const t = useT('bulk.tabs');

  return (
    <div className="mb-6 border-b">
      <nav className="flex gap-4">
        <button
          onClick={() => onTabChange('import')}
          className={`pb-3 text-sm font-medium transition ${
            activeTab === 'import'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span className="inline-flex items-center gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            {t('import')}
          </span>
        </button>
        <button
          onClick={() => onTabChange('export')}
          className={`pb-3 text-sm font-medium transition ${
            activeTab === 'export'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span className="inline-flex items-center gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            {t('export')}
          </span>
        </button>
      </nav>
    </div>
  );
}
