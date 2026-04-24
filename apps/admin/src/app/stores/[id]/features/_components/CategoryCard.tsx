'use client';

import { useT } from '@/i18n/useT';
import type { FeatureCategory, FeatureDefinition } from '@force/shared';
import { CategoryIcon } from './CategoryIcon';
import { FeatureRow } from './FeatureRow';

interface FeatureMetadata {
  featureKey: string;
  enabled: boolean;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

interface CategoryCardProps {
  category: FeatureCategory;
  features: FeatureDefinition[];
  displayState: Record<string, boolean>;
  localState: Record<string, boolean>;
  metadataMap: Map<string, FeatureMetadata>;
  saving: boolean;
  onToggle: (key: string, next: boolean) => void;
}

export function CategoryCard({
  category,
  features,
  displayState,
  localState,
  metadataMap,
  saving,
  onToggle,
}: CategoryCardProps) {
  const t = useT('features');
  const enabledCount = features.filter(f => displayState[f.key]).length;

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/40">
        <div className="flex items-center gap-3">
          <CategoryIcon category={category} />
          <div>
            <h2 className="font-semibold text-foreground">{t(`categories.${category}`)}</h2>
            <p className="text-xs text-muted-foreground">
              {t('category.enabledOfTotal', { enabled: enabledCount, total: features.length })}
            </p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-border">
        {features.map(def => (
          <FeatureRow
            key={def.key}
            def={def}
            isOn={displayState[def.key] ?? false}
            isDirty={def.key in localState}
            metadata={metadataMap.get(def.key)}
            saving={saving}
            onToggle={next => onToggle(def.key, next)}
          />
        ))}
      </div>
    </div>
  );
}
