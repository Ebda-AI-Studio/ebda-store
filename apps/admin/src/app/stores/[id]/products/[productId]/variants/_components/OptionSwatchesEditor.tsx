'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { DEFAULT_THEME, resolveColor, type StoreTheme } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { ImageUpload } from '@/components/ImageUpload';
import { ColorField } from '@/components/ColorField';
import { apiGet, apiPut } from '../../../../../../../lib/api';
import type { Option } from './types';

const FALLBACK_THEME: StoreTheme = DEFAULT_THEME;

interface Props {
  storeId: string;
  productId: string;
  options: Option[];
  onSaved: () => void;
}

interface Draft {
  hex: string;
  img: string;
}

/**
 * Swatch colour + photo for every value of every option. Used when the product
 * has 2+ option axes, where the variant table locks the value names. Sends only
 * values whose swatch changed; an emptied field is sent as null (clear).
 */
export function OptionSwatchesEditor({ storeId, productId, options, onSaved }: Props) {
  const t = useT('products.variants.simpleForm');
  const { success: toastSuccess, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [storeTheme, setStoreTheme] = useState<StoreTheme | undefined>();
  // The admin StoreContext carries no theme (id + name only), so the picker's theme
  // tokens come from one read here. Guarded: an unmount (or a store switch) before it
  // resolves must not set state on a stale editor.
  useEffect(() => {
    let live = true;
    apiGet<{ store: { theme?: StoreTheme } }>(`/api/v1/admin/stores/${storeId}`)
      .then(({ data }) => {
        if (live) setStoreTheme(data?.store?.theme);
      })
      .catch(() => {
        // non-critical: falls back to the default theme for the picker
      });
    return () => {
      live = false;
    };
  }, [storeId]);
  const theme = storeTheme ?? FALLBACK_THEME;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const init: Record<string, Draft> = {};
    for (const o of options)
      for (const v of o.values)
        init[v.id] = { hex: v.swatchHex ?? '', img: v.swatchImageUrl ?? '' };
    return init;
  });

  function patch(id: string, p: Partial<Draft>) {
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  async function save() {
    setSaving(true);
    try {
      // Name WHICH values failed ("Color: Rose"), not just how many.
      const failed: string[] = [];
      for (const o of options) {
        for (const v of o.values) {
          const d = drafts[v.id];
          if (!d || (d.hex === (v.swatchHex ?? '') && d.img === (v.swatchImageUrl ?? ''))) continue;
          const { error } = await apiPut(
            `/api/v1/stores/${storeId}/products/${productId}/option-values/${v.id}`,
            { swatchHex: d.hex || null, swatchImageUrl: d.img || null }
          );
          if (error) failed.push(`${o.name}: ${v.value}`);
        }
      }
      if (failed.length === 0) toastSuccess(t('swatchesSaved'));
      else toastError(t('saveFailedTitle'), t('swatchesFailed', { values: failed.join(' · ') }));
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border bg-card p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground">{t('swatchesTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('swatchesHint')}</p>
      <div className="mt-3 space-y-4">
        {options.map(o => (
          <div key={o.id}>
            <h3 className="text-sm font-medium text-foreground">{o.nameAr || o.name}</h3>
            <div className="mt-2 space-y-2">
              {o.values.map(v => {
                const d = drafts[v.id] ?? { hex: '', img: '' };
                return (
                  <div
                    key={v.id}
                    className="grid items-start gap-2 rounded-lg border border-border bg-background p-3 sm:grid-cols-[8rem_1fr_auto]"
                  >
                    <span className="pt-2 text-sm text-foreground">{v.valueAr || v.value}</span>
                    <ColorField
                      label={t('colSwatchColor')}
                      value={d.hex || undefined}
                      theme={theme}
                      showContrastPreview={false}
                      onChange={c => {
                        const hex = c.startsWith('#') ? c : resolveColor(c, theme);
                        if (!c) patch(v.id, { hex: '' });
                        else if (hex && /^#[0-9a-fA-F]{6}$/.test(hex))
                          patch(v.id, { hex: hex.toLowerCase() });
                      }}
                    />
                    <div>
                      <span className="mb-1 block text-xs font-medium text-muted-foreground">
                        {t('colSwatchImage')}
                      </span>
                      <ImageUpload
                        value={d.img || undefined}
                        onUpload={url => patch(v.id, { img: url })}
                        onRemove={() => patch(v.id, { img: '' })}
                        folder="products"
                        storeId={storeId}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <Button onClick={save} disabled={saving}>
          {t('swatchesSave')}
        </Button>
      </div>
    </div>
  );
}
