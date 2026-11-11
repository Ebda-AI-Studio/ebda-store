'use client';

/**
 * "3D model" card on the admin product page — the UI for `product_models` and
 * `product_model_bindings` (every-data-has-a-UI). Upload/replace the .glb,
 * optional .usdz, preview, poster, alt text, AR toggle, and the option-value →
 * finish mapping. Design: docs/plans/2026-10-07-product-3d-viewer.md.
 */
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import type { ProductModelViewerHandle } from '@ebda/ui/model3d';
import {
  DEFAULT_THEME,
  MODEL3D_MAX_BYTES,
  MODEL3D_METAL_PRESETS,
  model3dErrorMessage,
  resolveColor,
  validateGlb,
  validateUsdz,
  type ActiveModel3dLook,
  type Model3dMetalPreset,
} from '@ebda/shared';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { adminUiLocale, apiDelete, apiGet, apiPut, getApiUrl } from '../../../../../../lib/api';
import { useFeatures } from '../../../../../../hooks/useFeatures';
import { uploadErrorText } from '../../../../../../hooks/useImageUpload';
import { ImageUpload } from '../../../../../../components/ImageUpload';
import { ColorField } from '../../../../../../components/ColorField';
import { intlLocaleForUi } from '@/lib/format';
import { FIELD_CLASSES } from '@/components/ui/tokens';

const ProductModelViewer = dynamic(() => import('@ebda/ui/model3d'), {
  ssr: false,
  loading: () => null,
});

interface Binding {
  optionValueId: string;
  kind: 'material' | 'gltf_variant';
  target: string;
  color: string | null;
  metalness: number | null;
  roughness: number | null;
}

interface AdminModel {
  modelUrl: string;
  modelBytes: number;
  usdzUrl: string | null;
  usdzBytes: number | null;
  posterUrl: string | null;
  altText: string | null;
  altTextAr: string | null;
  arEnabled: boolean;
  materials: Array<{ index: number; name: string }>;
  gltfVariants: string[];
  stats: { vertices?: number; meshes?: number; textures?: number };
  bindings: Binding[];
}

interface OptionRow {
  id: string;
  name: string;
  nameAr: string | null;
  values: Array<{ id: string; value: string; valueAr: string | null }>;
}

/** The API's JSON envelope for the three upload endpoints this card calls. */
interface UploadBody {
  data?: {
    url?: string;
    model?: AdminModel;
    warnings?: string[];
    droppedBindings?: number;
    usdzUrl?: string;
    usdzBytes?: number;
  };
  error?: { message?: string; details?: { messageEn?: string; messageAr?: string } };
}

type Finish = Model3dMetalPreset | 'custom';
interface RowState {
  /** `m:<material>` | `v:<glTF variant>` | '' (no binding) */
  target: string;
  finish: Finish;
  color: string;
}

const PRESETS = Object.keys(MODEL3D_METAL_PRESETS) as Model3dMetalPreset[];

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** Multipart upload with progress — same transport as useImageUpload. */
type ProgressFn = (pct: number) => void;
interface UploadResult {
  ok: boolean;
  status: number;
  body: UploadBody | null;
}

function xhrUpload(
  url: string,
  file: Blob,
  fileName: string,
  onProgress: ProgressFn
): Promise<UploadResult> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, fileName);
    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    const done = () => {
      let body: UploadBody | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
    };
    xhr.addEventListener('load', done);
    xhr.addEventListener('error', done);
    xhr.addEventListener('timeout', done);
    // 15 MB on a slow uplink: allow 3 minutes before calling it failed.
    xhr.timeout = 180_000;
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.send(form);
  });
}

function rowsFrom(model: AdminModel | null, options: OptionRow[]): Record<string, RowState> {
  const rows: Record<string, RowState> = {};
  for (const o of options) {
    for (const v of o.values) rows[v.id] = { target: '', finish: 'gold', color: '#888888' };
  }
  for (const b of model?.bindings ?? []) {
    if (!rows[b.optionValueId]) continue;
    if (b.kind === 'gltf_variant') {
      rows[b.optionValueId] = { ...rows[b.optionValueId], target: `v:${b.target}` };
      continue;
    }
    const preset = PRESETS.find(
      p =>
        MODEL3D_METAL_PRESETS[p].color === b.color &&
        MODEL3D_METAL_PRESETS[p].metalness === b.metalness
    );
    rows[b.optionValueId] = {
      target: `m:${b.target}`,
      finish: preset ?? 'custom',
      color: b.color ?? '#888888',
    };
  }
  return rows;
}

function bindingFor(valueId: string, row: RowState): Binding | null {
  if (!row.target) return null;
  if (row.target.startsWith('v:')) {
    return {
      optionValueId: valueId,
      kind: 'gltf_variant',
      target: row.target.slice(2),
      color: null,
      metalness: null,
      roughness: null,
    };
  }
  const preset = row.finish === 'custom' ? null : MODEL3D_METAL_PRESETS[row.finish];
  return {
    optionValueId: valueId,
    kind: 'material',
    target: row.target.slice(2),
    color: preset ? preset.color : row.color,
    metalness: preset ? preset.metalness : 0,
    roughness: preset ? preset.roughness : 0.5,
  };
}

export function Product3dModelCard({ storeId, productId }: { storeId: string; productId: string }) {
  const t = useT('products.model3d');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  const enabled = isEnabled('product_3d');
  const { success: toastSuccess, error: toastError } = useToast();
  const askConfirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState<AdminModel | null>(null);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [altText, setAltText] = useState('');
  const [altTextAr, setAltTextAr] = useState('');
  const [arEnabled, setArEnabled] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [previewValueId, setPreviewValueId] = useState<string | null>(null);
  const viewerRef = useRef<ProductModelViewerHandle>(null);
  const glbInput = useRef<HTMLInputElement>(null);
  const usdzInput = useRef<HTMLInputElement>(null);
  const base = `/api/v1/stores/${storeId}/product-models/${productId}`;

  const adopt = useCallback((m: AdminModel | null, opts?: OptionRow[]) => {
    setModel(m);
    setAltText(m?.altText ?? '');
    setAltTextAr(m?.altTextAr ?? '');
    setArEnabled(m?.arEnabled ?? true);
    setRows(prev => (opts ? rowsFrom(m, opts) : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await apiGet<{ model: AdminModel | null; options: OptionRow[] }>(base);
      if (cancelled) return;
      if (data) {
        setOptions(data.options);
        adopt(data.model, data.options);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [base, adopt]);

  useEffect(
    () => () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
    },
    [localUrl]
  );

  async function onGlbPicked(file: File | undefined) {
    if (!file) return;
    setNotice(null);
    const check = validateGlb(new Uint8Array(await file.arrayBuffer()));
    if (!check.ok) {
      toastError(t('uploadFailed'), model3dErrorMessage(check.code, adminUiLocale()));
      return;
    }
    setBusy(true);
    setProgress(0);
    const res = await xhrUpload(`${getApiUrl()}${base}/glb`, file, file.name, setProgress);
    setBusy(false);
    setProgress(null);
    if (!res.ok) {
      // Bilingual details picked by the same rule as every admin upload reader (review M-5).
      toastError(t('uploadFailed'), uploadErrorText(res.body, String(res.status)));
      return;
    }
    if (localUrl) URL.revokeObjectURL(localUrl);
    setLocalUrl(URL.createObjectURL(file));
    const m = res.body?.data?.model ?? null;
    adopt(m, options);
    const warnings: string[] = res.body?.data?.warnings ?? [];
    const dropped: number = res.body?.data?.droppedBindings ?? 0;
    const parts = [
      ...warnings.map(w => (w === 'LARGE_FILE' ? t('warnLarge') : t('warnVertices'))),
      ...(dropped > 0 ? [t('droppedBindings', { count: dropped })] : []),
    ];
    setNotice(parts.length ? parts.join(' ') : null);
    toastSuccess(t('uploaded'), file.name);
  }

  async function onUsdzPicked(file: File | undefined) {
    if (!file) return;
    const check = validateUsdz(new Uint8Array(await file.arrayBuffer()));
    if (!check.ok) {
      toastError(t('uploadFailed'), model3dErrorMessage(check.code, adminUiLocale()));
      return;
    }
    setBusy(true);
    setProgress(0);
    const res = await xhrUpload(`${getApiUrl()}${base}/usdz`, file, file.name, setProgress);
    setBusy(false);
    setProgress(null);
    if (!res.ok) {
      toastError(t('uploadFailed'), uploadErrorText(res.body, String(res.status)));
      return;
    }
    const usdzUrl = res.body?.data?.usdzUrl ?? null;
    const usdzBytes = res.body?.data?.usdzBytes ?? null;
    setModel(m => (m ? { ...m, usdzUrl, usdzBytes } : m));
    toastSuccess(t('uploaded'), file.name);
  }

  async function put(body: Record<string, unknown>) {
    setBusy(true);
    const { data, error } = await apiPut<{ model: AdminModel }>(base, body);
    setBusy(false);
    if (error || !data) {
      toastError(t('saveFailed'), error?.message ?? '');
      return false;
    }
    adopt(data.model);
    return true;
  }

  async function capturePoster() {
    const blob = await viewerRef.current?.capture();
    if (!blob) return;
    setBusy(true);
    const params = new URLSearchParams({ folder: 'products', storeId });
    const res = await xhrUpload(
      `${getApiUrl()}/api/v1/uploads/image?${params.toString()}`,
      blob,
      'poster.webp',
      () => undefined
    );
    setBusy(false);
    const url = res.body?.data?.url;
    if (!res.ok || !url) {
      // A byte-sniff refusal carries both languages (B0-46), like the GLB validator's.
      toastError(t('uploadFailed'), uploadErrorText(res.body, String(res.status)));
      return;
    }
    if (await put({ posterUrl: url })) toastSuccess(t('posterSaved'), '');
  }

  async function saveDetails() {
    if (await put({ altText: altText || null, altTextAr: altTextAr || null, arEnabled })) {
      toastSuccess(t('saved'), '');
    }
  }

  async function saveBindings() {
    const bindings = Object.entries(rows)
      .map(([id, r]) => bindingFor(id, r))
      .filter((b): b is Binding => b !== null);
    setBusy(true);
    const { data, error } = await apiPut<{ model: AdminModel }>(`${base}/bindings`, { bindings });
    setBusy(false);
    if (error || !data) {
      toastError(t('saveFailed'), error?.message ?? '');
      return;
    }
    adopt(data.model);
    toastSuccess(t('mappingSaved'), '');
  }

  async function removeModel() {
    const ok = await askConfirm({
      object: t('removeDialog.object'),
      consequence: t('removeDialog.consequence'),
      confirmLabel: t('removeDialog.confirmLabel'),
    });
    if (!ok) return;
    setBusy(true);
    const { error } = await apiDelete(base);
    setBusy(false);
    if (error) {
      toastError(t('saveFailed'), error.message ?? '');
      return;
    }
    adopt(null, options);
    if (localUrl) URL.revokeObjectURL(localUrl);
    setLocalUrl(null);
    toastSuccess(t('removed'), '');
  }

  // Preview the finish of one mapping row live in the viewer.
  const previewLook = useMemo<ActiveModel3dLook | undefined>(() => {
    if (!previewValueId || !rows[previewValueId]) return undefined;
    const b = bindingFor(previewValueId, rows[previewValueId]);
    if (!b) return undefined;
    return b.kind === 'gltf_variant'
      ? { materials: {}, gltfVariant: b.target }
      : {
          materials: {
            [b.target]: { color: b.color!, metalness: b.metalness, roughness: b.roughness },
          },
          gltfVariant: null,
        };
  }, [previewValueId, rows]);

  const setRow = (id: string, patch: Partial<RowState>) =>
    setRows(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  if (loading || featuresLoading) {
    return (
      <div className="rounded-md border bg-card p-6">
        <div className="h-6 w-40 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  const hasTargets = !!model && (model.materials.length > 0 || model.gltfVariants.length > 0);

  return (
    <section className="rounded-md border bg-card p-6" aria-labelledby="model3d-heading">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 id="model3d-heading" className="text-lg font-semibold text-foreground">
          {t('title')}
        </h2>
        {model && (
          <Button variant="outline" size="sm" onClick={removeModel} disabled={busy}>
            {t('remove')}
          </Button>
        )}
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        {t('intro', { mb: mb(MODEL3D_MAX_BYTES) })}
      </p>

      {!enabled && (
        <p className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('disabled')}
        </p>
      )}

      <input
        ref={glbInput}
        type="file"
        accept=".glb,model/gltf-binary"
        className="sr-only"
        aria-label={t('chooseGlb')}
        onChange={e => {
          void onGlbPicked(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={usdzInput}
        type="file"
        accept=".usdz,model/vnd.usdz+zip"
        className="sr-only"
        aria-label={t('chooseUsdz')}
        onChange={e => {
          void onUsdzPicked(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {!model ? (
        enabled && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <Button onClick={() => glbInput.current?.click()} disabled={busy}>
              {t('chooseGlb')}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">{t('formatHint')}</p>
          </div>
        )
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="relative aspect-square overflow-hidden rounded-lg border bg-muted/30">
              <ProductModelViewer
                handleRef={viewerRef}
                src={localUrl ?? model.modelUrl}
                poster={model.posterUrl}
                alt={model.altText || t('title')}
                look={previewLook}
                autoRotate={false}
                labels={{
                  loading: t('loading'),
                  error: t('previewError'),
                  hint: t('hint'),
                  ar: t('ar'),
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('stats', {
                mb: mb(model.modelBytes),
                vertices: (model.stats.vertices ?? 0).toLocaleString(intlLocaleForUi()),
                materials: model.materials.length,
              })}
            </p>
            {notice && (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-foreground">{notice}</p>
            )}
            {progress !== null && (
              <p role="status" className="text-xs text-muted-foreground">
                {t('uploading', { pct: progress })}
              </p>
            )}
            {enabled && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => glbInput.current?.click()}
                  disabled={busy}
                >
                  {t('replace')}
                </Button>
                <Button variant="outline" size="sm" onClick={capturePoster} disabled={busy}>
                  {t('capturePoster')}
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {enabled && (
              <>
                <ImageUpload
                  label={t('poster')}
                  value={model.posterUrl ?? undefined}
                  folder="products"
                  storeId={storeId}
                  onUpload={url => void put({ posterUrl: url })}
                  onRemove={() => void put({ posterUrl: null })}
                />
                <Input
                  label={t('altText')}
                  value={altText}
                  maxLength={250}
                  onChange={e => setAltText(e.target.value)}
                />
                <Input
                  label={t('altTextAr')}
                  dir="rtl"
                  value={altTextAr}
                  maxLength={250}
                  onChange={e => setAltTextAr(e.target.value)}
                />
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={arEnabled}
                    onChange={e => setArEnabled(e.target.checked)}
                  />
                  {t('arEnabled')}
                </label>
                <div className="rounded-lg border border-border p-3 text-sm">
                  <p className="font-medium text-foreground">{t('usdzTitle')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {model.usdzUrl
                      ? t('usdzSet', { mb: mb(model.usdzBytes ?? 0) })
                      : t('usdzGenerated')}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => usdzInput.current?.click()}
                      disabled={busy}
                    >
                      {t('chooseUsdz')}
                    </Button>
                    {model.usdzUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void put({ usdzUrl: null })}
                        disabled={busy}
                      >
                        {t('removeUsdz')}
                      </Button>
                    )}
                  </div>
                </div>
                <Button onClick={saveDetails} disabled={busy}>
                  {t('save')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {model && enabled && (
        <div className="mt-6 border-t border-border pt-6">
          <h3 className="text-base font-semibold text-foreground">{t('mappingTitle')}</h3>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('mappingIntro')}</p>
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noOptions')}</p>
          ) : !hasTargets ? (
            <p className="text-sm text-muted-foreground">{t('noMaterials')}</p>
          ) : (
            <div className="space-y-5">
              {options.map(o => (
                <div key={o.id}>
                  <p className="mb-2 text-sm font-medium text-foreground">
                    {locale === 'ar' && o.nameAr ? o.nameAr : o.name}
                  </p>
                  <div className="space-y-2">
                    {o.values.map(v => {
                      const row = rows[v.id];
                      if (!row) return null;
                      const isMaterial = row.target.startsWith('m:');
                      return (
                        <div
                          key={v.id}
                          className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2"
                        >
                          <span className="min-w-[6rem] text-sm text-foreground">
                            {locale === 'ar' && v.valueAr ? v.valueAr : v.value}
                          </span>
                          <label className="text-sm text-muted-foreground">
                            {t('target')}
                            <select
                              className={`${FIELD_CLASSES} mt-1 block`}
                              value={row.target}
                              onChange={e => setRow(v.id, { target: e.target.value })}
                            >
                              <option value="">{t('noBinding')}</option>
                              {model.materials.length > 0 && (
                                <optgroup label={t('materials')}>
                                  {model.materials.map(m => (
                                    <option key={`m${m.index}`} value={`m:${m.name}`}>
                                      {m.name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              {model.gltfVariants.length > 0 && (
                                <optgroup label={t('gltfVariants')}>
                                  {model.gltfVariants.map(n => (
                                    <option key={`v${n}`} value={`v:${n}`}>
                                      {n}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                          </label>
                          {isMaterial && (
                            <label className="text-sm text-muted-foreground">
                              {t('finish')}
                              <select
                                className={`${FIELD_CLASSES} mt-1 block`}
                                value={row.finish}
                                onChange={e => setRow(v.id, { finish: e.target.value as Finish })}
                              >
                                {PRESETS.map(p => (
                                  <option key={p} value={p}>
                                    {t(`presets.${p}` as Parameters<typeof t>[0])}
                                  </option>
                                ))}
                                <option value="custom">{t('presets.custom')}</option>
                              </select>
                            </label>
                          )}
                          {isMaterial && row.finish === 'custom' && (
                            <div className="min-w-[14rem]">
                              <ColorField
                                label={t('colour')}
                                value={row.color}
                                theme={DEFAULT_THEME}
                                showContrastPreview={false}
                                onChange={c => {
                                  // Materials need a concrete hex, not a theme token.
                                  const hex = c.startsWith('#')
                                    ? c
                                    : resolveColor(c, DEFAULT_THEME);
                                  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
                                    setRow(v.id, { color: hex.toLowerCase() });
                                  }
                                }}
                              />
                            </div>
                          )}
                          {row.target && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPreviewValueId(v.id)}
                              aria-pressed={previewValueId === v.id}
                            >
                              {t('preview')}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <Button onClick={saveBindings} disabled={busy}>
                {t('saveMapping')}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
