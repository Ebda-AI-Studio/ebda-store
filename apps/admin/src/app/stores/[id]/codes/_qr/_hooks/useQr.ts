'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { storeOrigin } from '@ebda/shared';
import { liveDomain } from '@/lib/store-url';
import {
  DEFAULT_QR_DESIGN,
  buildScene,
  qrLink,
  selfCheck,
  type QrDesign,
  type QrKind,
  type QrSettings,
  type Scene,
  type SelfCheck,
} from '@ebda/shared/qr';
import { apiGet, apiPut } from '../../../../../../lib/api';

export type QrTarget = { kind: QrKind; slug?: string; label?: string };

export type QrStoreInfo = {
  name: string;
  slug: string;
  domain: string | null;
  hasWhatsapp: boolean;
  logo: string | null;
};

export type QrStatRow = {
  kind: QrKind;
  ref: string;
  label: string;
  labelAr: string | null;
  scans: number;
};

type SettingsResponse = {
  settings: QrSettings;
  slug: string;
  domain: string | null;
  hasWhatsapp: boolean;
};

/** Reads the store logo into a data: URL (so the SVG file is self-contained and the canvas stays clean). */
async function loadLogo(url: string): Promise<{ dataUrl: string; image: HTMLImageElement }> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error('logo fetch failed');
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(dataUrl)) throw new Error('logo type');
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('logo decode'));
    image.src = dataUrl;
  });
  return { dataUrl, image };
}

export function useQr(storeId: string) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [store, setStore] = useState<QrStoreInfo | null>(null);
  const [design, setDesign] = useState<QrDesign>(DEFAULT_QR_DESIGN);
  const [whatsappText, setWhatsappText] = useState('');
  const [saved, setSaved] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle');
  const [target, setTarget] = useState<QrTarget>({ kind: 'store' });
  const [stats, setStats] = useState<QrStatRow[] | null>(null);
  const [logo, setLogo] = useState<{ dataUrl: string; image: HTMLImageElement } | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [settingsRes, storeRes, statsRes] = await Promise.all([
        apiGet<SettingsResponse>(`/api/v1/stores/${storeId}/qr/settings`),
        apiGet<{ store: { name: string; logo?: string | null } }>(`/api/v1/stores/${storeId}`),
        apiGet<{ rows: QrStatRow[] }>(`/api/v1/stores/${storeId}/qr/stats?days=30`),
      ]);
      if (!alive) return;
      const s = settingsRes.data;
      if (!s) {
        setLoadError(true);
        setLoading(false);
        return;
      }
      setStore({
        name: storeRes.data?.store?.name ?? '',
        slug: s.slug,
        domain: s.domain,
        hasWhatsapp: s.hasWhatsapp,
        logo: storeRes.data?.store?.logo ?? null,
      });
      setDesign(s.settings.design);
      setWhatsappText(s.settings.whatsappText ?? '');
      setSaved(JSON.stringify({ d: s.settings.design, w: s.settings.whatsappText ?? '' }));
      setStats(statsRes.data?.rows ?? []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [storeId]);

  const logoUrl = store?.logo ?? null;
  useEffect(() => {
    if (!design.logo || !logoUrl) return;
    let alive = true;
    setLogoFailed(false);
    loadLogo(logoUrl)
      .then(l => alive && setLogo(l))
      .catch(() => {
        if (!alive) return;
        setLogo(null);
        setLogoFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [design.logo, logoUrl]);

  const liveHost = store ? liveDomain(store) : null;
  const origin = store ? (liveHost ? `https://${liveHost}` : storeOrigin(store.slug)) : '';

  const payload = useMemo(() => {
    if (!store) return null;
    try {
      return qrLink(target.kind, origin, target.slug);
    } catch {
      return null;
    }
  }, [store, origin, target]);

  // The design that is actually drawn: a logo that failed to load is never drawn (nor checked).
  const effective: QrDesign = useMemo(
    () => (design.logo && !logo ? { ...design, logo: false } : design),
    [design, logo]
  );
  const deferred = useDeferredValue(effective);
  const checkPayload = payload ?? (store ? qrLink('store', origin) : null);

  const scene: Scene | null = useMemo(
    () => (payload ? buildScene(payload, deferred) : null),
    [payload, deferred]
  );
  const check: SelfCheck | null = useMemo(
    () => (checkPayload ? selfCheck(checkPayload, deferred) : null),
    [checkPayload, deferred]
  );

  const dirty = JSON.stringify({ d: design, w: whatsappText }) !== saved;

  const save = useCallback(async () => {
    setSaving(true);
    setSaveState('idle');
    const body: QrSettings = {
      design,
      ...(whatsappText.trim() ? { whatsappText: whatsappText.trim() } : {}),
    };
    const { error } = await apiPut(`/api/v1/stores/${storeId}/qr/settings`, body);
    setSaving(false);
    if (error) {
      setSaveState('error');
      return;
    }
    setSaved(JSON.stringify({ d: design, w: whatsappText }));
    setSaveState('saved');
  }, [design, whatsappText, storeId]);

  return {
    loading,
    loadError,
    store,
    design,
    setDesign,
    whatsappText,
    setWhatsappText,
    target,
    setTarget,
    payload,
    scene,
    check,
    logo,
    logoFailed,
    dirty,
    saving,
    saveState,
    save,
    stats,
  };
}
