'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiFetch } from '../../../../lib/api';

// Typography is store-scoped and template-agnostic — the storefront's
// data-zone wrappers in ShopChrome (and the in-template grid wrappers)
// catch the same six zones regardless of which pack the merchant has
// active. Keep this UI in lock-step with the Zod schema in
// apps/api/src/routes/typography.routes.ts.

const ZONES: Array<{ key: ZoneKey; label: string }> = [
  { key: 'beforeHeader', label: 'Before header (announcement bar)' },
  { key: 'header', label: 'Header' },
  { key: 'categories', label: 'Categories' },
  { key: 'products', label: 'Products' },
  { key: 'footer', label: 'Footer' },
  { key: 'afterFooter', label: 'After footer' },
];

type ZoneKey = 'beforeHeader' | 'header' | 'categories' | 'products' | 'footer' | 'afterFooter';

interface ZoneSettings {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  lineHeight?: string;
  letterSpacing?: string;
}

type FontSource =
  | { type: 'google'; url: string; family: string }
  | {
      type: 'custom';
      family: string;
      url: string;
      format: 'woff2' | 'woff' | 'ttf' | 'otf';
      weight?: string;
      style?: 'normal' | 'italic';
    };

interface Typography {
  fonts: FontSource[];
  zones: Partial<Record<ZoneKey, ZoneSettings>>;
}

const EMPTY: Typography = { fonts: [], zones: {} };

// Common Google font picks shown as quick-add suggestions. The merchant
// can also paste any other CSS URL from fonts.google.com.
const QUICK_GOOGLE_FONTS: Array<{ family: string; url: string }> = [
  {
    family: 'Inter',
    url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
  {
    family: 'Playfair Display',
    url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
  },
  {
    family: 'Cairo',
    url: 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap',
  },
  {
    family: 'Tajawal',
    url: 'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap',
  },
  {
    family: 'Poppins',
    url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap',
  },
  {
    family: 'Lora',
    url: 'https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&display=swap',
  },
];

export default function TypographyPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: toastError } = useToast();

  const [typo, setTypo] = useState<Typography>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [googleUrlDraft, setGoogleUrlDraft] = useState('');
  const [googleFamilyDraft, setGoogleFamilyDraft] = useState('');
  const [customFamilyDraft, setCustomFamilyDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const { data, error } = await apiGet<{ typography: Typography }>(
      `/api/v1/stores/${storeId}/typography`
    );
    if (!error && data?.typography) {
      setTypo({
        fonts: Array.isArray(data.typography.fonts) ? data.typography.fonts : [],
        zones: data.typography.zones ?? {},
      });
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (next: Typography) => {
      setSaving(true);
      const { error } = await apiPut<{ typography: Typography }>(
        `/api/v1/stores/${storeId}/typography`,
        next
      );
      setSaving(false);
      if (error) {
        toastError('Save failed', error.message ?? '');
        return false;
      }
      toastSuccess('Typography saved');
      return true;
    },
    [storeId, toastError, toastSuccess]
  );

  const updateZone = (zone: ZoneKey, patch: Partial<ZoneSettings>) => {
    const current = typo.zones[zone] ?? {};
    const merged = { ...current, ...patch };
    // Strip empty strings so the API receives clean optional fields.
    const cleaned: ZoneSettings = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === 'string' && v.trim()) cleaned[k as keyof ZoneSettings] = v.trim();
    }
    setTypo(t => ({ ...t, zones: { ...t.zones, [zone]: cleaned } }));
  };

  const addGoogleFont = (url: string, family: string) => {
    const u = url.trim();
    const f = family.trim();
    if (!u || !f) return;
    if (typo.fonts.some(font => font.type === 'google' && font.url === u)) return;
    setTypo(t => ({ ...t, fonts: [...t.fonts, { type: 'google', url: u, family: f }] }));
    setGoogleUrlDraft('');
    setGoogleFamilyDraft('');
  };

  const removeFont = (idx: number) => {
    setTypo(t => ({ ...t, fonts: t.fonts.filter((_, i) => i !== idx) }));
  };

  const onFontFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!customFamilyDraft.trim()) {
      toastError('Family name required', 'Pick a family name before uploading a font file.');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch(`/api/v1/uploads/font?storeId=${storeId}`, {
        method: 'POST',
        body: form,
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        toastError('Upload failed', json?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const { url, format } = json.data as {
        url: string;
        format: 'woff2' | 'woff' | 'ttf' | 'otf';
      };
      setTypo(t => ({
        ...t,
        fonts: [...t.fonts, { type: 'custom', family: customFamilyDraft.trim(), url, format }],
      }));
      setCustomFamilyDraft('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toastSuccess('Font uploaded');
    } finally {
      setUploading(false);
    }
  };

  // Family suggestions for the per-zone family <select>. Merchant-loaded
  // fonts come first, then a small set of system fallbacks they can use
  // even without uploading anything.
  const familyOptions = [
    { value: '', label: 'Inherit from template' },
    ...typo.fonts.map(f => ({
      value: `'${f.family}'`,
      label: `${f.family} (${f.type === 'google' ? 'Google' : 'Custom'})`,
    })),
    { value: 'system-ui, sans-serif', label: 'System UI' },
    { value: 'Georgia, serif', label: 'Georgia (serif)' },
    { value: 'Menlo, monospace', label: 'Menlo (mono)' },
  ];

  return (
    <AdminLayout
      title="Typography"
      subtitle="Per-store font, size, and color overrides for every storefront zone"
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}`}>
            <Button type="button" variant="outline">
              Back to Store
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => save(typo)}
            disabled={saving}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 font-medium disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Loading typography settings…
        </div>
      ) : (
        <div className="space-y-6">
          {/* Fonts library */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="text-base font-semibold text-foreground">Fonts library</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Add the fonts you want to use in any zone below. Either paste a Google Fonts URL or
              upload your own font file (.woff2 / .woff / .ttf / .otf).
            </p>

            {typo.fonts.length > 0 && (
              <ul className="mt-4 space-y-2">
                {typo.fonts.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">{f.family}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {f.type === 'google' ? 'Google Fonts' : `Custom (${f.format})`} — {f.url}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFont(i)}
                      className="shrink-0 rounded-lg border border-destructive/30 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/5"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Add Google font */}
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <input
                type="text"
                placeholder="Family name (e.g. Inter)"
                value={googleFamilyDraft}
                onChange={e => setGoogleFamilyDraft(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                type="url"
                placeholder="Google Fonts CSS URL"
                value={googleUrlDraft}
                onChange={e => setGoogleUrlDraft(e.target.value)}
                className="md:col-span-2 rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => addGoogleFont(googleUrlDraft, googleFamilyDraft)}
                disabled={!googleUrlDraft.trim() || !googleFamilyDraft.trim()}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Add Google font
              </button>
              <span className="text-xs text-muted-foreground">Quick picks:</span>
              {QUICK_GOOGLE_FONTS.map(g => (
                <button
                  key={g.family}
                  type="button"
                  onClick={() => addGoogleFont(g.url, g.family)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {g.family}
                </button>
              ))}
            </div>

            {/* Upload custom font */}
            <div className="mt-5 rounded-xl border border-dashed border-border/80 bg-background/40 p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  type="text"
                  placeholder="Family name (e.g. BrandSans)"
                  value={customFamilyDraft}
                  onChange={e => setCustomFamilyDraft(e.target.value)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
                  disabled={uploading || !customFamilyDraft.trim()}
                  onChange={onFontFile}
                  className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90 disabled:opacity-50"
                />
              </div>
              {uploading && (
                <p className="mt-2 text-xs text-muted-foreground">Uploading font file…</p>
              )}
            </div>
          </section>

          {/* Per-zone controls */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="text-base font-semibold text-foreground">Zones</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Each zone wraps a region of every template via the storefront's <code>data-zone</code>{' '}
              attributes. Leave a field blank to inherit from the active template.
            </p>
            <div className="mt-4 space-y-5">
              {ZONES.map(z => {
                const cfg = typo.zones[z.key] ?? {};
                return (
                  <div key={z.key} className="rounded-xl border border-border/60 bg-background p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">{z.label}</h3>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Font family
                        </span>
                        <select
                          value={cfg.fontFamily ?? ''}
                          onChange={e => updateZone(z.key, { fontFamily: e.target.value })}
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        >
                          {familyOptions.map(o => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Font size (e.g. 16px, 1rem)
                        </span>
                        <input
                          type="text"
                          value={cfg.fontSize ?? ''}
                          onChange={e => updateZone(z.key, { fontSize: e.target.value })}
                          placeholder="inherit"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Font weight (e.g. 400, bold)
                        </span>
                        <input
                          type="text"
                          value={cfg.fontWeight ?? ''}
                          onChange={e => updateZone(z.key, { fontWeight: e.target.value })}
                          placeholder="inherit"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">Color</span>
                        <div className="flex gap-2">
                          <input
                            type="color"
                            value={
                              cfg.color && /^#[0-9a-f]{6}$/i.test(cfg.color) ? cfg.color : '#000000'
                            }
                            onChange={e => updateZone(z.key, { color: e.target.value })}
                            className="h-10 w-12 cursor-pointer rounded-lg border border-border bg-background"
                            aria-label="Pick color"
                          />
                          <input
                            type="text"
                            value={cfg.color ?? ''}
                            onChange={e => updateZone(z.key, { color: e.target.value })}
                            placeholder="#000000 / hsl(...) / rgb(...)"
                            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                        </div>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Line height
                        </span>
                        <input
                          type="text"
                          value={cfg.lineHeight ?? ''}
                          onChange={e => updateZone(z.key, { lineHeight: e.target.value })}
                          placeholder="inherit"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Letter spacing
                        </span>
                        <input
                          type="text"
                          value={cfg.letterSpacing ?? ''}
                          onChange={e => updateZone(z.key, { letterSpacing: e.target.value })}
                          placeholder="inherit"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </AdminLayout>
  );
}
