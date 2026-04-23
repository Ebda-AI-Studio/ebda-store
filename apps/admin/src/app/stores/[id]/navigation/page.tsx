'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Input, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiPut } from '../../../../lib/api';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';

interface NavItem {
  label: string;
  labelAr?: string;
  href: string;
}

const DEFAULT_MENU: NavItem[] = [
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

export default function StoreNavigationPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const toast = useToast();

  const { store, isLoading, error: fetchError } = useCurrentStore(storeId);
  const [items, setItems] = useState<NavItem[]>([]);
  const [itemsHydrated, setItemsHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const existingSettings = (store?.settings ?? {}) as Record<string, unknown>;

  // Hydrate the editor's local list from the store's saved navMenu the first
  // time the hook resolves. Subsequent refetches (e.g. after save) shouldn't
  // blow away local edits, hence the one-shot guard.
  useEffect(() => {
    if (itemsHydrated) return;
    if (!store) return;
    const current = sanitize(existingSettings.navMenu);
    setItems(current.length > 0 ? current : DEFAULT_MENU);
    setItemsHydrated(true);
  }, [store, existingSettings, itemsHydrated]);

  useEffect(() => {
    if (fetchError) toast.error('Failed to load', fetchError.message);
  }, [fetchError, toast]);

  function update(index: number, field: keyof NavItem, value: string) {
    setItems(prev => prev.map((it, i) => (i === index ? { ...it, [field]: value } : it)));
  }

  function addItem() {
    setItems(prev => [...prev, { label: '', labelAr: '', href: '' }]);
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

  async function handleSave() {
    // Filter out blank rows — we don't want to persist empties.
    const cleaned = items
      .map(it => ({
        label: it.label.trim(),
        labelAr: it.labelAr?.trim() || undefined,
        href: it.href.trim(),
      }))
      .filter(it => it.label && it.href);

    if (cleaned.length === 0) {
      toast.error('At least one menu item required', 'Add a label and href.');
      return;
    }

    setIsSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}`, {
      settings: { ...existingSettings, navMenu: cleaned },
    });
    setIsSaving(false);

    if (error) {
      toast.error('Failed to save', error.message);
      return;
    }
    toast.success('Navigation saved', 'Storefront will use the new menu on next page load.');
  }

  if (isLoading) {
    return (
      <AdminLayout title="Navigation">
        <div className="flex h-64 items-center justify-center text-muted-foreground">Loading…</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Navigation">
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={`/stores/${storeId}`} className="hover:text-primary">
            Store
          </Link>
          <span>/</span>
          <Link href={`/stores/${storeId}/settings`} className="hover:text-primary">
            Settings
          </Link>
          <span>/</span>
          <span className="text-foreground">Navigation</span>
        </div>

        <h1 className="text-2xl font-bold text-foreground">Storefront Navigation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control the header menu on every storefront page. Use relative paths (
          <code className="rounded bg-muted px-1">/products</code>) for store pages, or full URLs
          for external links.
        </p>

        <div className="mt-8 space-y-4">
          {items.map((item, index) => (
            <div key={index} className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Item {index + 1}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                    aria-label="Move up"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 15l7-7 7 7"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === items.length - 1}
                    className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                    aria-label="Move down"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(index)}
                    className="rounded p-1 text-destructive hover:bg-destructive/10"
                    aria-label="Remove item"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Input
                  label="Label (English)"
                  value={item.label}
                  onChange={e => update(index, 'label', e.target.value)}
                  placeholder="Products"
                />
                <Input
                  label="Label (Arabic)"
                  value={item.labelAr ?? ''}
                  onChange={e => update(index, 'labelAr', e.target.value)}
                  placeholder="المنتجات"
                />
                <Input
                  label="Path or URL"
                  value={item.href}
                  onChange={e => update(index, 'href', e.target.value)}
                  placeholder="/products"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={addItem} variant="outline">
            + Add item
          </Button>
          <Button onClick={resetToDefault} variant="ghost">
            Reset to defaults
          </Button>
          <div className="flex-1" />
          <Button onClick={handleSave} isLoading={isSaving}>
            Save navigation
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}
