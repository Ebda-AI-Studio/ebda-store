'use client';

import { useT } from '@/i18n/useT';
import type { FeatureDefinition } from '@force/shared';
import { ToggleSwitch } from './ToggleSwitch';

interface FeatureMetadata {
  featureKey: string;
  enabled: boolean;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

interface FeatureRowProps {
  def: FeatureDefinition;
  isOn: boolean;
  isDirty: boolean;
  metadata?: FeatureMetadata;
  saving: boolean;
  onToggle: (next: boolean) => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function FeatureRow({ def, isOn, isDirty, metadata, saving, onToggle }: FeatureRowProps) {
  const t = useT('features');

  return (
    <div
      className={`flex items-start justify-between px-6 py-4 transition-colors ${
        isDirty ? 'bg-primary/5/50' : 'hover:bg-muted/30'
      }`}
    >
      <div className="flex-1 min-w-0 me-4">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="font-medium text-foreground">{def.name}</p>
          {isDirty && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
              {t('actions.unsaved')}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{def.description}</p>
        {isOn && metadata?.enabledAt && metadata?.enabledBy && (
          <p className="text-xs text-muted-foreground mt-1">
            {t('row.enabledBy')}{' '}
            <span className="font-medium text-foreground">{metadata.enabledBy}</span>{' '}
            {t('row.enabledOn')} {formatDate(metadata.enabledAt)}
          </p>
        )}
      </div>
      <div className="flex-shrink-0 pt-0.5">
        <ToggleSwitch enabled={isOn} onChange={onToggle} disabled={saving} />
      </div>
    </div>
  );
}
