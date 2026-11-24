'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { storeOrigin } from '@ebda/shared';
import {
  DEFAULT_LABEL_SETTINGS,
  labelPresetById,
  layoutLabel,
  type LabelItem,
  type LabelLayout,
  type LabelSettings,
} from '@ebda/shared';
import { DEFAULT_QR_DESIGN, buildScene, qrLink, type QrDesign, type Scene } from '@ebda/shared/qr';
import { apiGet, apiPost, apiPut } from '../../../../../lib/api';

export type PickerItem = {
  id: string;
  kind: 'product' | 'variant';
  productId: string;
  productSlug: string;
  name: string;
  nameAr: string | null;
  variantTitle: string | null;
  variantTitleAr: string | null;
  priceMinor: number;
  barcode: string | null;
};

export const SAMPLE_ITEM: LabelItem = {
  name: 'Sample product',
  nameAr: 'منتج تجريبي',
  variantTitle: 'M',
  variantTitleAr: 'م',
  priceMinor: 25000,
  barcode: '2000000000015',
};

/** Product page on the store's own domain, the target of the label QR. */
const productQrUrl = (origin: string, slug: string) =>
  origin ? qrLink('product', origin, slug) : null;

/** The QR scene drawn on a label (plain: no logo, frame or call to action: dots stay big). */
export const labelQrScene = (url: string, design: QrDesign): Scene =>
  buildScene(url, { ...design, logo: false, frame: 'none', cta: null });

export function toLabelItem(i: PickerItem, origin: string): LabelItem | null {
  if (!i.barcode) return null;
  return {
    name: i.name,
    nameAr: i.nameAr,
    variantTitle: i.variantTitle,
    variantTitleAr: i.variantTitleAr,
    priceMinor: i.priceMinor,
    barcode: i.barcode,
    qrUrl: productQrUrl(origin, i.productSlug),
  };
}

type SettingsResponse = { settings: LabelSettings; slug: string; domain: string | null };

export function useLabels(storeId: string) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [settings, setSettings] = useState<LabelSettings>(DEFAULT_LABEL_SETTINGS);
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle');
  const [origin, setOrigin] = useState('');
  const [qrDesign, setQrDesign] = useState<QrDesign>(DEFAULT_QR_DESIGN);

  const [search, setSearch] = useState('');
  const [items, setItems] = useState<PickerItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [selected, setSelected] = useState<Record<string, { item: PickerItem; qty: number }>>({});
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, q] = await Promise.all([
        apiGet<SettingsResponse>(`/api/v1/stores/${storeId}/barcodes/settings`),
        apiGet<{ settings: { design: QrDesign } }>(`/api/v1/stores/${storeId}/qr/settings`),
      ]);
      if (!alive) return;
      if (!s.data) {
        setLoadError(true);
        setLoading(false);
        return;
      }
      setSettings(s.data.settings);
      setSaved(JSON.stringify(s.data.settings));
      setOrigin(s.data.domain ? `https://${s.data.domain}` : storeOrigin(s.data.slug));
      if (q.data?.settings?.design) setQrDesign(q.data.settings.design);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [storeId]);

  const loadItems = useCallback(
    async (opts: { reset: boolean; cursor?: string | null }) => {
      const ticket = ++latest.current;
      setItemsLoading(true);
      const qs = new URLSearchParams({ limit: '30' });
      if (search.trim()) qs.set('search', search.trim());
      if (!opts.reset && opts.cursor) qs.set('cursor', opts.cursor);
      const { data } = await apiGet<{ items: PickerItem[]; nextCursor: string | null }>(
        `/api/v1/stores/${storeId}/barcodes/items?${qs}`
      );
      if (ticket !== latest.current) return; // a newer search is already in flight
      setItemsLoading(false);
      if (!data) return;
      setItems(prev => (opts.reset ? data.items : [...prev, ...data.items]));
      setNextCursor(data.nextCursor);
    },
    [storeId, search]
  );

  useEffect(() => {
    if (loading || loadError) return;
    const t = setTimeout(() => void loadItems({ reset: true }), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [loading, loadError, loadItems, search]);

  const toggle = (item: PickerItem) =>
    setSelected(cur => {
      const next = { ...cur };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = { item, qty: 1 };
      return next;
    });
  const setQty = (id: string, qty: number) =>
    setSelected(cur =>
      cur[id]
        ? { ...cur, [id]: { ...cur[id], qty: Math.max(1, Math.min(500, Math.round(qty) || 1)) } }
        : cur
    );

  const generateMissing = useCallback(async () => {
    setGenerating(true);
    setGenerateError(false);
    let guard = 0;
    for (;;) {
      const { data, error } = await apiPost<{
        products: number;
        variants: number;
        remaining: number;
      }>(`/api/v1/stores/${storeId}/barcodes/generate`);
      if (error || !data) {
        setGenerateError(true);
        break;
      }
      if (data.remaining === 0 || data.products + data.variants === 0 || ++guard >= 20) break;
    }
    setGenerating(false);
    setSelected({});
    await loadItems({ reset: true });
  }, [storeId, loadItems]);

  const deferred = useDeferredValue(settings);
  const preset =
    labelPresetById(deferred.preset) ?? labelPresetById(DEFAULT_LABEL_SETTINGS.preset)!;
  const chosen = Object.values(selected);
  const previewItem: LabelItem = useMemo(() => {
    const first = chosen.map(c => toLabelItem(c.item, origin)).find(Boolean);
    return first ?? { ...SAMPLE_ITEM, qrUrl: productQrUrl(origin, 'sample-product') };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, origin]);
  const layout: LabelLayout = useMemo(
    () => layoutLabel(preset, previewItem, deferred),
    [preset, previewItem, deferred]
  );
  const qrScene: Scene | null = useMemo(() => {
    if (!layout.qr) return null;
    return labelQrScene(layout.qr.url, qrDesign);
  }, [layout.qr, qrDesign]);

  const dirty = JSON.stringify(settings) !== saved;
  const save = useCallback(async () => {
    setSaving(true);
    setSaveState('idle');
    const { error } = await apiPut(`/api/v1/stores/${storeId}/barcodes/settings`, settings);
    setSaving(false);
    if (error) {
      setSaveState('error');
      return;
    }
    setSaved(JSON.stringify(settings));
    setSaveState('saved');
  }, [settings, storeId]);

  return {
    loading,
    loadError,
    settings,
    setSettings,
    preset,
    layout,
    qrScene,
    qrOrigin: origin,
    qrDesign,
    previewItem,
    isSample: !chosen.some(c => c.item.barcode),
    dirty,
    saving,
    saveState,
    save,
    search,
    setSearch,
    items,
    itemsLoading,
    nextCursor,
    loadMore: () => loadItems({ reset: false, cursor: nextCursor }),
    selected,
    toggle,
    setQty,
    chosen,
    generateMissing,
    generating,
    generateError,
  };
}
