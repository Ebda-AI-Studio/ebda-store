'use client';

import { useStore } from '@/contexts/StoreContext';
import { useLanguage } from '@/contexts/LanguageContext';

export function StorePicker() {
  const { stores, selectedStoreId, setSelectedStoreId } = useStore();
  const { t } = useLanguage();

  // A single-store merchant doesn't need a picker.
  if (stores.length <= 1) return null;

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{t.store.pick}</span>
      <select
        value={selectedStoreId ?? ''}
        onChange={e => setSelectedStoreId(e.target.value)}
        className="h-9 max-w-[10rem] rounded-full border border-border bg-card px-3 text-sm font-medium text-foreground"
      >
        {stores.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
