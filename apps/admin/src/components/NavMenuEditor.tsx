'use client';

/**
 * NavMenuEditor — reusable navigation menu editor.
 *
 * Renders the same nav-item form in two contexts:
 *   variant="standalone"  → kept for a full-page host; /stores/[id]/navigation now redirects to the editor
 *   variant="embedded"    → used by visual editor, rendered inside a SectionCard
 *
 * Data is saved directly to settings.navMenu via PUT /api/v1/stores/:id.
 * The editor is self-contained (owns its own state + save button).
 */

import { useEffect, useMemo, useState } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiPut } from '../lib/api';
import { useCurrentStore } from '../hooks/useCurrentStore';
import { useT } from '@/i18n/useT';

export interface NavItem {
  label: string;
  labelAr?: string;
  href: string;
}

export const DEFAULT_MENU: NavItem[] = [
  { label: 'Products', labelAr: 'المنتجات', href: '/products' },
  { label: 'Categories', labelAr: 'الفئات', href: '/categories' },
  { label: 'About', labelAr: 'من نحن', href: '/about' },
  { label: 'Contact', labelAr: 'تواصل معنا', href: '/contact' },
];

function sanitize(value: unknown): NavItem[] {
  if (!Array.isArray(value)) return [];
  const items: NavItem[] = [];
  for (const entry of value) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { label?: unknown }).label === 'string' &&
      typeof (entry as { href?: unknown }).href === 'string'
    ) {
      const e = entry as { label: string; labelAr?: unknown; href: string };
      items.push({
        label: e.label,
        labelAr: typeof e.labelAr === 'string' ? e.labelAr : undefined,
        href: e.href,
      });
    }
  }
  return items;
}

interface NavMenuEditorProps {
  storeId: string;
  variant: 'standalone' | 'embedded';
  /**
   * When provided, the editor registers a silent save here and HIDES its own
   * Save button — so the visual editor's main Save button persists the nav menu
   * alongside everything else. Returns true on success (or when there's nothing
   * valid to save, so it never blocks the unified save).
   */
  saveRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  /**
   * When provided, the editor keeps this ref up-to-date with the current
   * (unsaved) nav menu state so the visual editor can include it in the
   * preview-draft bundle without requiring a save first.
   */
  stateRef?: React.MutableRefObject<NavItem[] | null>;
}

export function NavMenuEditor({ storeId, variant, saveRef, stateRef }: NavMenuEditorProps) {
  const toast = useToast();
  const t = useT('navigation.page');

  const { store, error: fetchError } = useCurrentStore(storeId);
  const [items, setItems] = useState<NavItem[]>([]);
  const [itemsHydrated, setItemsHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const existingSettings = useMemo(
    () => (store?.settings ?? {}) as Record<string, unknown>,
    [store?.settings]
  );

  // One-shot hydration from the store's saved navMenu.
  useEffect(() => {
    if (itemsHydrated) return;
    if (!store) return;
    const current = sanitize(existingSettings.navMenu);
    setItems(current.length > 0 ? current : DEFAULT_MENU);
    setItemsHydrated(true);
  }, [store, existingSettings, itemsHydrated]);

  useEffect(() => {
    if (fetchError) toast.error(t('toastFailedLoad'), fetchError.message);
  }, [fetchError, toast, t]);

  // Keep stateRef in sync with the live items so the editor can read
  // the current (unsaved) nav menu for the preview-draft bundle.
  useEffect(() => {
    if (stateRef) stateRef.current = items;
  }, [items, stateRef]);

  function update(index: number, field: keyof NavItem, value: string) {
    setItems(prev => prev.map((it, i) => (i === index ? { ...it, [field]: value } : it)));
  }

  function addItem() {
    setItems(prev => [...prev, { label: '', labelAr: '', href: '' }]);
  }

  function addLocationsLink() {
    // Only add if no /locations entry is already present.
    if (items.some(it => it.href === '/locations')) return;
    setItems(prev => [...prev, { label: 'Locations', labelAr: 'الفروع', href: '/locations' }]);
  }

  function removeItem(index: number) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  function move(index: number, direction: -1 | 1) {
    setItems(prev => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  }

  function resetToDefault() {
    setItems(DEFAULT_MENU);
  }

  async function handleSave(opts?: { silent?: boolean }): Promise<boolean> {
    const cleaned = items
      .map(it => ({
        label: it.label.trim(),
        labelAr: it.labelAr?.trim() || undefined,
        href: it.href.trim(),
      }))
      .filter(it => it.label && it.href);

    if (cleaned.length === 0) {
      // Silent (unified) save must not block on an empty menu — just skip.
      if (opts?.silent) return true;
      toast.error(t('toastAtLeastOne'), t('toastAtLeastOneBody'));
      return false;
    }

    setIsSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
      settings: { ...existingSettings, navMenu: cleaned },
    });
    setIsSaving(false);

    if (error) {
      toast.error(t('toastFailedSave'), error.message);
      return false;
    }
    if (!opts?.silent) toast.success(t('toastSaved'), t('toastSavedBody'));
    return true;
  }

  // Register a silent save for the visual editor's main Save button.
  if (saveRef) saveRef.current = () => handleSave({ silent: true });

  const isEmbedded = variant === 'embedded';

  return (
    <div className={isEmbedded ? '' : 'mx-auto max-w-3xl p-6'}>
      {!isEmbedded && (
        <div className="mb-6">
          <p className="text-sm text-muted-foreground">
            {t('helpBefore')}
            <code className="rounded-md bg-muted px-1">{t('helpCode')}</code>
            {t('helpAfter')}
          </p>
        </div>
      )}

      <div className={isEmbedded ? 'space-y-3' : 'mt-8 space-y-4'}>
        {items.map((item, index) => (
          <div
            key={index}
            className={`rounded-md border bg-card shadow-sm ${isEmbedded ? 'p-3' : 'p-4'}`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('itemNumber', { number: index + 1 })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="text-muted-foreground"
                  aria-label={t('moveUp')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === items.length - 1}
                  className="text-muted-foreground"
                  aria-label={t('moveDown')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  onClick={() => removeItem(index)}
                  className="text-destructive-ink"
                  aria-label={t('removeItem')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Input
                label={t('labelEnglish')}
                value={item.label}
                onChange={e => update(index, 'label', e.target.value)}
                placeholder={t('labelEnglishPlaceholder')}
              />
              <Input
                label={t('labelArabic')}
                value={item.labelAr ?? ''}
                onChange={e => update(index, 'labelAr', e.target.value)}
                placeholder={t('labelArabicPlaceholder')}
              />
              <Input
                label={t('pathOrUrl')}
                value={item.href}
                onChange={e => update(index, 'href', e.target.value)}
                placeholder={t('pathPlaceholder')}
              />
            </div>
          </div>
        ))}
      </div>

      <div className={`flex flex-wrap items-center gap-3 ${isEmbedded ? 'mt-3' : 'mt-6'}`}>
        <Button onClick={addItem} variant="outline" size={isEmbedded ? 'sm' : 'md'}>
          {t('addItem')}
        </Button>
        <Button
          onClick={addLocationsLink}
          variant="outline"
          size={isEmbedded ? 'sm' : 'md'}
          disabled={items.some(it => it.href === '/locations')}
        >
          {t('addLocationsLink')}
        </Button>
        <Button onClick={resetToDefault} variant="ghost" size={isEmbedded ? 'sm' : 'md'}>
          {t('resetDefault')}
        </Button>
        <div className="flex-1" />
        {/* Hidden when the visual editor owns saving (saveRef provided) — the
            main Save button persists the nav menu via the registered saver. */}
        {!saveRef && (
          <Button onClick={() => handleSave()} isLoading={isSaving} size={isEmbedded ? 'sm' : 'md'}>
            {t('saveNav')}
          </Button>
        )}
      </div>
    </div>
  );
}
