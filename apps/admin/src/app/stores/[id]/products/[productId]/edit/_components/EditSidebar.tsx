'use client';

import { Button, Select } from '@force/ui';
import { useT } from '@/i18n/useT';

interface Option {
  value: string;
  label: string;
}

interface EditSidebarProps {
  status: string;
  onStatusChange: (value: string) => void;
  statuses: Option[];
  category: string;
  onCategoryChange: (value: string) => void;
  categoryOptions: Option[];
  isFeatured: boolean;
  onFeaturedChange: (value: boolean) => void;
  isNew: boolean;
  onIsNewChange: (value: boolean) => void;
  saving: boolean;
  onCancel: () => void;
}

export function EditSidebar({
  status,
  onStatusChange,
  statuses,
  category,
  onCategoryChange,
  categoryOptions,
  isFeatured,
  onFeaturedChange,
  isNew,
  onIsNewChange,
  saving,
  onCancel,
}: EditSidebarProps) {
  const tSections = useT('products.edit.sections');
  const tFields = useT('products.edit.fields');
  const tActions = useT('products.edit.actions');

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('status')}</h2>
        <Select
          label={tFields('productStatus')}
          value={status}
          onChange={e => onStatusChange(e.target.value)}
          options={statuses}
        />
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('organization')}</h2>
        <Select
          label={tFields('category')}
          value={category}
          onChange={e => onCategoryChange(e.target.value)}
          options={categoryOptions}
        />
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">{tSections('flags')}</h2>
        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={e => onFeaturedChange(e.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <span className="text-sm text-foreground">{tFields('featured')}</span>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isNew}
              onChange={e => onIsNewChange(e.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <span className="text-sm text-foreground">{tFields('newArrival')}</span>
          </label>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="space-y-3">
          <Button type="submit" className="w-full" isLoading={saving}>
            {tActions('saveChanges')}
          </Button>
          <Button type="button" variant="outline" className="w-full" onClick={onCancel}>
            {tActions('cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
