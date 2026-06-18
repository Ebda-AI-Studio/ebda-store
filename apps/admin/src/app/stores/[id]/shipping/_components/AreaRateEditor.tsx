'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@force/ui';
import { KUWAIT_GOVERNORATES } from '@force/shared';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AreaRate {
  id?: string;
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
  deliveryFee: number; // fils
  freeShippingThreshold: number | null; // fils
  isActive: boolean;
  position: number;
}

// Per-row local state (KWD strings for inputs)
interface AreaRowState {
  isActive: boolean;
  feeKwd: string; // "1.500"
  thresholdKwd: string; // "10.000" or ""
}

type AreaStateMap = Record<string, AreaRowState>; // key = `${governorate}||${area}`

interface Props {
  storeId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kwdToFils(kwd: string): number {
  const n = parseFloat(kwd);
  if (isNaN(n) || n < 0) return 0;
  return Math.round(n * 1000);
}

function filsToKwd(fils: number): string {
  return (fils / 1000).toFixed(3);
}

function rowKey(governorate: string, area: string) {
  return `${governorate}||${area}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AreaRateEditor({ storeId }: Props) {
  const t = useT('shipping.areaRates');
  const { success: toastSuccess, error: toastError } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [areaState, setAreaState] = useState<AreaStateMap>({});

  // Accordion: which governorate is open
  const [openGov, setOpenGov] = useState<string | null>(null);

  // Bulk-apply per-governorate input value
  const [bulkFeeKwd, setBulkFeeKwd] = useState<Record<string, string>>({});

  // ── Fetch existing rates ──────────────────────────────────────────────────

  const fetchRates = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiGet<{ rates: AreaRate[] }>(
        `/api/v1/stores/${storeId}/shipping/area-rates`
      );

      const map: AreaStateMap = {};
      // Pre-populate all canonical areas as inactive/empty
      for (const gov of KUWAIT_GOVERNORATES) {
        for (const area of gov.areas) {
          const k = rowKey(gov.en, area.en);
          map[k] = { isActive: false, feeKwd: '', thresholdKwd: '' };
        }
      }
      // Overlay saved rates
      if (data?.rates) {
        for (const rate of data.rates) {
          const k = rowKey(rate.governorate, rate.area);
          map[k] = {
            isActive: rate.isActive,
            feeKwd: rate.deliveryFee > 0 ? filsToKwd(rate.deliveryFee) : '',
            thresholdKwd:
              rate.freeShippingThreshold != null ? filsToKwd(rate.freeShippingThreshold) : '',
          };
        }
      }
      setAreaState(map);
    } catch {
      toastError(t('errorTitle'), t('fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t, toastError]);

  useEffect(() => {
    fetchRates();
  }, [fetchRates]);

  // ── Row updates ────────────────────────────────────────────────────────────

  function updateRow(key: string, patch: Partial<AreaRowState>) {
    setAreaState(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  // ── Bulk apply ─────────────────────────────────────────────────────────────

  function applyBulkFee(govEn: string) {
    const gov = KUWAIT_GOVERNORATES.find(g => g.en === govEn);
    if (!gov) return;
    const feeKwd = bulkFeeKwd[govEn] ?? '';
    setAreaState(prev => {
      const next = { ...prev };
      for (const area of gov.areas) {
        const k = rowKey(gov.en, area.en);
        next[k] = { ...next[k], feeKwd, isActive: feeKwd !== '' };
      }
      return next;
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleSave() {
    setSaving(true);
    try {
      const rates: Array<{
        governorate: string;
        governorateAr: string;
        area: string;
        areaAr: string;
        deliveryFee: number;
        freeShippingThreshold?: number;
        isActive: boolean;
        position: number;
      }> = [];

      let position = 0;
      for (const gov of KUWAIT_GOVERNORATES) {
        for (const area of gov.areas) {
          const k = rowKey(gov.en, area.en);
          const row = areaState[k];
          if (!row) continue;
          const fee = kwdToFils(row.feeKwd);
          // Include if active OR has a non-zero fee
          if (!row.isActive && fee === 0) continue;
          const entry: (typeof rates)[number] = {
            governorate: gov.en,
            governorateAr: gov.ar,
            area: area.en,
            areaAr: area.ar,
            deliveryFee: fee,
            isActive: row.isActive,
            position: position++,
          };
          if (row.thresholdKwd.trim() !== '') {
            entry.freeShippingThreshold = kwdToFils(row.thresholdKwd);
          }
          rates.push(entry);
        }
      }

      const { error } = await apiPut(`/api/v1/stores/${storeId}/shipping/area-rates/bulk`, {
        rates,
      });

      if (error) {
        toastError(t('errorTitle'), t('saveFailed'));
      } else {
        toastSuccess(t('savedTitle'), t('savedDescription'));
        fetchRates();
      }
    } catch {
      toastError(t('errorTitle'), t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  // ── Counts for accordion header ────────────────────────────────────────────

  function feeCount(govEn: string): number {
    const gov = KUWAIT_GOVERNORATES.find(g => g.en === govEn);
    if (!gov) return 0;
    return gov.areas.filter(area => {
      const row = areaState[rowKey(govEn, area.en)];
      return row && (row.isActive || kwdToFils(row.feeKwd) > 0);
    }).length;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Governorate accordion */}
      <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
        {KUWAIT_GOVERNORATES.map(gov => {
          const isOpen = openGov === gov.en;
          const count = feeCount(gov.en);

          return (
            <div key={gov.en}>
              {/* Accordion header */}
              <button
                type="button"
                onClick={() => setOpenGov(isOpen ? null : gov.en)}
                className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/70 transition-colors text-start"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-foreground">{gov.en}</span>
                  <span className="text-muted-foreground font-arabic text-sm">{gov.ar}</span>
                  {count > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                      {count} / {gov.areas.length}
                    </span>
                  )}
                </div>
                <svg
                  className={`w-5 h-5 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {/* Accordion body */}
              {isOpen && (
                <div className="bg-background">
                  {/* Bulk-apply row */}
                  <div className="flex items-center gap-2 px-4 py-3 bg-muted/20 border-b border-border">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {t('applyAll')}
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder="0.000"
                      value={bulkFeeKwd[gov.en] ?? ''}
                      onChange={e => setBulkFeeKwd(prev => ({ ...prev, [gov.en]: e.target.value }))}
                      className="w-24 px-2 py-1 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    <span className="text-xs text-muted-foreground">{t('currency')}</span>
                    <button
                      type="button"
                      onClick={() => applyBulkFee(gov.en)}
                      className="px-3 py-1 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
                    >
                      {t('applyBtn')}
                    </button>
                  </div>

                  {/* Area rows */}
                  <div className="divide-y divide-border/60">
                    {gov.areas.map(area => {
                      const k = rowKey(gov.en, area.en);
                      const row = areaState[k] ?? {
                        isActive: false,
                        feeKwd: '',
                        thresholdKwd: '',
                      };

                      return (
                        <div
                          key={area.en}
                          className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-2.5"
                        >
                          {/* Active toggle */}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={row.isActive}
                            onClick={() => updateRow(k, { isActive: !row.isActive })}
                            className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
                              row.isActive ? 'bg-primary' : 'bg-muted'
                            }`}
                          >
                            <span
                              className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                                row.isActive
                                  ? 'translate-x-5 rtl:-translate-x-5'
                                  : 'translate-x-1 rtl:-translate-x-1'
                              }`}
                            />
                          </button>

                          {/* Area name */}
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-foreground">{area.en}</span>
                            <span className="text-xs text-muted-foreground font-arabic ms-2">
                              {area.ar}
                            </span>
                          </div>

                          {/* Fee input */}
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              step="0.001"
                              placeholder="0.000"
                              value={row.feeKwd}
                              onChange={e => {
                                const val = e.target.value;
                                updateRow(k, {
                                  feeKwd: val,
                                  isActive: val !== '' ? true : row.isActive,
                                });
                              }}
                              aria-label={`${t('feeLabel')} – ${area.en}`}
                              className="w-24 px-2 py-1 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary text-end"
                            />
                            <span className="text-xs text-muted-foreground">{t('currency')}</span>
                          </div>

                          {/* Free-over threshold */}
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                              {t('freeOver')}
                            </span>
                            <input
                              type="number"
                              min="0"
                              step="0.001"
                              placeholder={t('optional')}
                              value={row.thresholdKwd}
                              onChange={e => updateRow(k, { thresholdKwd: e.target.value })}
                              aria-label={`${t('freeOverLabel')} – ${area.en}`}
                              className="w-24 px-2 py-1 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary text-end"
                            />
                            <span className="text-xs text-muted-foreground">{t('currency')}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save button */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving && (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
}
