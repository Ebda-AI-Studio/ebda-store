'use client';

import {
  forwardRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { useToast } from '@ebda/ui';
import { EGYPT_GOVERNORATES, minorToDecimalString, REGION } from '@ebda/shared';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut, apiDelete, apiFetch } from '../../../../../lib/api';
import { RowActions } from '../../../../../components/RowActions';
import { majorToMinor, getIncompleteNewRows } from './areaRateValidation';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
// ─── Types ───────────────────────────────────────────────────────────────────

interface AreaRate {
  id?: string;
  country: string;
  countryAr: string;
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
  deliveryFee: number; // piastres
  freeShippingThreshold: number | null; // piastres
  isActive: boolean;
  position: number;
}

// Per-row local state (EGP strings for inputs)
interface AreaRowState {
  isActive: boolean;
  feeMajor: string; // "15.00"
  thresholdMajor: string; // "100.00" or ""
}

type AreaStateMap = Record<string, AreaRowState>; // key = `${governorate}||${area}`

// A custom row: a rate that is not part of the static Egypt list
interface CustomRow {
  /** DB id — present if the row was fetched from the server; absent if unsaved */
  id?: string;
  country: string;
  countryAr: string;
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
  isActive: boolean;
  feeMajor: string;
  thresholdMajor: string;
}

interface Props {
  storeId: string;
  /** Tells the page whether the grid has edits that are not saved yet (it owns the one sticky Save bar). */
  onDirtyChange?: (dirty: boolean) => void;
}

/** What the page calls from its sticky save bar. */
export interface AreaRateEditorHandle {
  /** Saves every rate in one request. Resolves true when it saved. */
  save: () => Promise<boolean>;
  /** Drops the unsaved edits (reloads the saved rates). */
  reset: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minorToMajor(piastres: number): string {
  return minorToDecimalString(piastres);
}

function rowKey(governorate: string, area: string) {
  return `${governorate}||${area}`;
}

/** Returns true if the (country, governorate, area) triple belongs to the static Egypt list */
function isEgyptStatic(country: string, governorate: string, area: string): boolean {
  if (country !== REGION.countryName.en) return false;
  const gov = EGYPT_GOVERNORATES.find(g => g.en === governorate);
  if (!gov) return false;
  return gov.areas.some(a => a.en === area);
}

interface ImportPreview {
  valid: Array<{
    governorate: string;
    area: string;
    deliveryFee: number;
    freeShippingThreshold: number | null;
    isActive: boolean;
  }>;
  errors: Array<{ row: number; area: string; reason: string }>;
  wouldUpsert: number;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}
function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-1 rtl:-translate-x-1'
        }`}
      />
    </button>
  );
}

interface FeeInputsProps {
  feeMajor: string;
  thresholdMajor: string;
  onFeeChange: (v: string) => void;
  onThresholdChange: (v: string) => void;
  feeLabel: string;
  freeOverLabel: string;
  currencyLabel: string;
  optionalLabel: string;
  freeOverHint: string;
}
function FeeInputs({
  feeMajor,
  thresholdMajor,
  onFeeChange,
  onThresholdChange,
  feeLabel,
  freeOverLabel,
  currencyLabel,
  optionalLabel,
  freeOverHint,
}: FeeInputsProps) {
  return (
    <>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={feeMajor}
          onChange={e => onFeeChange(e.target.value)}
          aria-label={feeLabel}
          className={`${FIELD_CLASSES} w-24 text-end`}
        />
        <span className="text-xs text-muted-foreground">{currencyLabel}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
          {freeOverHint}
        </span>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder={optionalLabel}
          value={thresholdMajor}
          onChange={e => onThresholdChange(e.target.value)}
          aria-label={freeOverLabel}
          className={`${FIELD_CLASSES} w-24 text-end`}
        />
        <span className="text-xs text-muted-foreground">{currencyLabel}</span>
      </div>
    </>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export const AreaRateEditor = forwardRef<AreaRateEditorHandle, Props>(function AreaRateEditor(
  { storeId, onDirtyChange },
  ref
) {
  const t = useT('shipping.areaRates');
  // One name per row, in the admin's language (the EN + AR pair read as "Cairoالقاهرة").
  const isAr = useLocale() === 'ar';
  const { success: toastSuccess, error: toastError } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Static Egypt area state (same structure as before)
  const [areaState, setAreaState] = useState<AreaStateMap>({});
  // The grid as last loaded/saved; the sticky Save bar shows only while the grid differs from it.
  const [baseline, setBaseline] = useState<string | null>(null);
  // First-run card ("one price for all of Egypt"): fee + free-over, saved in one click.
  const [oneFee, setOneFee] = useState('');
  const [oneThreshold, setOneThreshold] = useState('');

  // Custom (non-static) rows — country/province/area added by the merchant
  const [customRows, setCustomRows] = useState<CustomRow[]>([]);

  // Accordion: which Egypt governorate is open
  const [openGov, setOpenGov] = useState<string | null>(null);
  // Accordion: which custom-country is open (keyed by country EN)
  const [openCustomCountry, setOpenCustomCountry] = useState<string | null>(null);

  // Bulk-apply per-governorate input value (Egypt static)
  const [bulkFeeMajor, setBulkFeeMajor] = useState<Record<string, string>>({});
  // Per-governorate free-shipping-over threshold (decoupled from the fee apply).
  const [bulkThresholdMajor, setBulkThresholdMajor] = useState<Record<string, string>>({});

  // Global bulk-apply: applies one flat fee + free-over threshold to ALL
  // areas across ALL Egypt governorates at once.
  const [globalBulkFeeMajor, setGlobalBulkFeeMajor] = useState('');
  const [globalBulkThresholdMajor, setGlobalBulkThresholdMajor] = useState('');

  // "Add area" inline forms per (country||governorate) key
  const [addAreaForm, setAddAreaForm] = useState<
    Record<string, { area: string; areaAr: string; feeMajor: string }>
  >({});
  // Which add-area inline forms are open
  const [addAreaOpen, setAddAreaOpen] = useState<Record<string, boolean>>({});

  // "Add custom location" panel
  const [addLocOpen, setAddLocOpen] = useState(false);
  const [addLocForm, setAddLocForm] = useState({
    country: '',
    countryAr: '',
    governorate: '',
    governorateAr: '',
    area: '',
    areaAr: '',
    feeMajor: '',
  });

  // Import/export
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Fetch existing rates ──────────────────────────────────────────────────

  const fetchRates = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiGet<{ rates: AreaRate[] }>(
        `/api/v1/stores/${storeId}/shipping/area-rates`
      );

      const map: AreaStateMap = {};
      // Pre-populate all canonical areas as inactive/empty
      for (const gov of EGYPT_GOVERNORATES) {
        for (const area of gov.areas) {
          const k = rowKey(gov.en, area.en);
          map[k] = { isActive: false, feeMajor: '', thresholdMajor: '' };
        }
      }

      const custom: CustomRow[] = [];

      if (data?.rates) {
        for (const rate of data.rates) {
          if (isEgyptStatic(rate.country, rate.governorate, rate.area)) {
            // Overlay onto the static Egypt map
            const k = rowKey(rate.governorate, rate.area);
            map[k] = {
              isActive: rate.isActive,
              feeMajor: rate.deliveryFee > 0 ? minorToMajor(rate.deliveryFee) : '',
              thresholdMajor:
                rate.freeShippingThreshold != null ? minorToMajor(rate.freeShippingThreshold) : '',
            };
          } else {
            // Non-static: add to custom rows
            custom.push({
              id: rate.id,
              country: rate.country,
              countryAr: rate.countryAr,
              governorate: rate.governorate,
              governorateAr: rate.governorateAr,
              area: rate.area,
              areaAr: rate.areaAr,
              isActive: rate.isActive,
              feeMajor: rate.deliveryFee > 0 ? minorToMajor(rate.deliveryFee) : '',
              thresholdMajor:
                rate.freeShippingThreshold != null ? minorToMajor(rate.freeShippingThreshold) : '',
            });
          }
        }
      }

      setAreaState(map);
      setCustomRows(custom);
      setBaseline(JSON.stringify({ areaState: map, customRows: custom }));
    } catch {
      toastError(t('errorTitle'), t('fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t, toastError]);

  useEffect(() => {
    fetchRates();
  }, [fetchRates]);

  // ── Static Egypt row updates ─────────────────────────────────────────────

  function updateRow(key: string, patch: Partial<AreaRowState>) {
    setAreaState(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  // ── Custom row updates ────────────────────────────────────────────────────

  function updateCustomRow(idx: number, patch: Partial<CustomRow>) {
    setCustomRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function removeCustomRow(idx: number) {
    const row = customRows[idx];
    if (row.id) {
      // Has a DB record — delete it
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/shipping/area-rates/${row.id}`);
      if (error) {
        toastError(t('errorTitle'), t('deleteFailed'));
        return;
      }
    }
    setCustomRows(prev => prev.filter((_, i) => i !== idx));
  }

  // ── Bulk apply (Egypt static) ────────────────────────────────────────────

  function applyBulkFee(govEn: string) {
    const gov = EGYPT_GOVERNORATES.find(g => g.en === govEn);
    if (!gov) return;
    const feeMajor = bulkFeeMajor[govEn] ?? '';
    setAreaState(prev => {
      const next = { ...prev };
      for (const area of gov.areas) {
        const k = rowKey(gov.en, area.en);
        next[k] = { ...next[k], feeMajor, isActive: feeMajor !== '' };
      }
      return next;
    });
  }

  // ── Global bulk-apply (ALL Egypt areas across ALL governorates) ──────────

  // Apply ONE flat fee to every area in every governorate. Leaves each area's
  // free-over threshold untouched (decoupled from the free-over apply below).
  function applyGlobalFee() {
    const feeMajor = globalBulkFeeMajor.trim();
    if (feeMajor === '') return;
    setAreaState(prev => {
      const next = { ...prev };
      for (const gov of EGYPT_GOVERNORATES) {
        for (const area of gov.areas) {
          const k = rowKey(gov.en, area.en);
          next[k] = { ...next[k], feeMajor, isActive: true };
        }
      }
      return next;
    });
  }

  // Apply ONE free-shipping-over threshold to every area in every governorate.
  // Decoupled — leaves each area's fee untouched (so the merchant can set a
  // uniform "free over X" across the country without overwriting the fees).
  function applyGlobalThreshold() {
    const thresholdMajor = globalBulkThresholdMajor.trim();
    if (thresholdMajor === '') return;
    setAreaState(prev => {
      const next = { ...prev };
      for (const gov of EGYPT_GOVERNORATES) {
        for (const area of gov.areas) {
          const k = rowKey(gov.en, area.en);
          next[k] = { ...next[k], thresholdMajor };
        }
      }
      return next;
    });
  }

  // Apply ONE free-shipping-over threshold to every area in ONE governorate.
  // Decoupled from the per-governorate fee apply (leaves fees untouched).
  function applyBulkThreshold(govEn: string) {
    const gov = EGYPT_GOVERNORATES.find(g => g.en === govEn);
    if (!gov) return;
    const thresholdMajor = bulkThresholdMajor[govEn] ?? '';
    if (thresholdMajor === '') return;
    setAreaState(prev => {
      const next = { ...prev };
      for (const area of gov.areas) {
        const k = rowKey(gov.en, area.en);
        next[k] = { ...next[k], thresholdMajor };
      }
      return next;
    });
  }

  // ── Add area inline form ──────────────────────────────────────────────────

  const addAreaFormKey = (country: string, governorate: string) => `${country}||${governorate}`;

  function toggleAddAreaForm(country: string, governorate: string) {
    const k = addAreaFormKey(country, governorate);
    setAddAreaOpen(prev => ({ ...prev, [k]: !prev[k] }));
    if (!addAreaForm[k]) {
      setAddAreaForm(prev => ({ ...prev, [k]: { area: '', areaAr: '', feeMajor: '' } }));
    }
  }

  function submitAddArea(
    country: string,
    countryAr: string,
    governorate: string,
    governorateAr: string
  ) {
    const k = addAreaFormKey(country, governorate);
    const form = addAreaForm[k];
    if (!form || !form.area.trim()) return;

    const newRow: CustomRow = {
      country,
      countryAr,
      governorate,
      governorateAr,
      area: form.area.trim(),
      areaAr: form.areaAr.trim(),
      // A zone the merchant explicitly adds is meant to be USED — default it
      // active so it saves + applies at checkout, even with a 0 / blank fee
      // (a legitimate FREE-delivery zone). Defaulting to `feeMajor !== ''` made
      // free zones inactive → silently dropped / blocked on save.
      isActive: true,
      feeMajor: form.feeMajor,
      thresholdMajor: '',
    };

    setCustomRows(prev => [...prev, newRow]);
    // Reset and close the form
    setAddAreaForm(prev => ({ ...prev, [k]: { area: '', areaAr: '', feeMajor: '' } }));
    setAddAreaOpen(prev => ({ ...prev, [k]: false }));
  }

  // ── Add custom location panel ─────────────────────────────────────────────

  function submitAddLoc() {
    if (!addLocForm.country.trim() || !addLocForm.governorate.trim() || !addLocForm.area.trim())
      return;

    const newRow: CustomRow = {
      country: addLocForm.country.trim(),
      countryAr: addLocForm.countryAr.trim(),
      governorate: addLocForm.governorate.trim(),
      governorateAr: addLocForm.governorateAr.trim(),
      area: addLocForm.area.trim(),
      areaAr: addLocForm.areaAr.trim(),
      // Explicitly-added location → default active so a free (0 / blank fee)
      // zone actually saves + applies, instead of being created inactive and
      // dropped. See submitAddArea for the full rationale.
      isActive: true,
      feeMajor: addLocForm.feeMajor,
      thresholdMajor: '',
    };

    setCustomRows(prev => [...prev, newRow]);
    setAddLocForm({
      country: '',
      countryAr: '',
      governorate: '',
      governorateAr: '',
      area: '',
      areaAr: '',
      feeMajor: '',
    });
    setAddLocOpen(false);
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleSave(override?: {
    areaState: AreaStateMap;
    customRows: CustomRow[];
  }): Promise<boolean> {
    const stateNow = override?.areaState ?? areaState;
    const rowsNow = override?.customRows ?? customRows;
    // Guard against silently dropping brand-new zones/areas the merchant just
    // added but left inactive with no fee. These rows would otherwise be
    // filtered out of the bulk payload below while `handleSave` still shows a
    // success toast — telling the merchant it saved when it didn't.
    const incompleteNewRows = getIncompleteNewRows(rowsNow);
    if (incompleteNewRows.length > 0) {
      const names = incompleteNewRows.map(r => r.area).join(', ');
      toastError(t('errorTitle'), t('incompleteRowsError', { areas: names }));
      return false;
    }

    setSaving(true);
    try {
      const rates: Array<{
        country: string;
        countryAr: string;
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

      // 1. Static Egypt rows
      for (const gov of EGYPT_GOVERNORATES) {
        for (const area of gov.areas) {
          const k = rowKey(gov.en, area.en);
          const row = stateNow[k];
          if (!row) continue;
          const fee = majorToMinor(row.feeMajor);
          if (!row.isActive && fee === 0) continue;
          const entry: (typeof rates)[number] = {
            country: REGION.countryName.en,
            countryAr: REGION.countryName.ar,
            governorate: gov.en,
            governorateAr: gov.ar,
            area: area.en,
            areaAr: area.ar,
            deliveryFee: fee,
            isActive: row.isActive,
            position: position++,
          };
          if (row.thresholdMajor.trim() !== '') {
            entry.freeShippingThreshold = majorToMinor(row.thresholdMajor);
          }
          rates.push(entry);
        }
      }

      // 2. Custom rows (includes custom Egypt areas AND other countries)
      for (const row of rowsNow) {
        const fee = majorToMinor(row.feeMajor);
        if (!row.isActive && fee === 0) continue;
        const entry: (typeof rates)[number] = {
          country: row.country,
          countryAr: row.countryAr,
          governorate: row.governorate,
          governorateAr: row.governorateAr,
          area: row.area,
          areaAr: row.areaAr,
          deliveryFee: fee,
          isActive: row.isActive,
          position: position++,
        };
        if (row.thresholdMajor.trim() !== '') {
          entry.freeShippingThreshold = majorToMinor(row.thresholdMajor);
        }
        rates.push(entry);
      }

      const { error } = await apiPut(`/api/v1/stores/${storeId}/shipping/area-rates/bulk`, {
        rates,
      });

      if (error) {
        toastError(t('errorTitle'), t('saveFailed'));
        return false;
      }
      toastSuccess(t('savedTitle'), t('savedDescription'));
      await fetchRates();
      return true;
    } catch {
      toastError(t('errorTitle'), t('saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  // The first-run card: one fee (and an optional free-over amount) for every area in Egypt, saved in one click.
  async function saveOnePrice() {
    const feeMajor = oneFee.trim();
    if (feeMajor === '') return;
    const thresholdMajor = oneThreshold.trim();
    const next: AreaStateMap = { ...areaState };
    for (const gov of EGYPT_GOVERNORATES) {
      for (const area of gov.areas) {
        const k = rowKey(gov.en, area.en);
        next[k] = {
          ...next[k],
          feeMajor,
          isActive: true,
          ...(thresholdMajor !== '' ? { thresholdMajor } : {}),
        };
      }
    }
    setAreaState(next);
    await handleSave({ areaState: next, customRows });
  }

  const currentSnapshot = useMemo(
    () => JSON.stringify({ areaState, customRows }),
    [areaState, customRows]
  );
  const dirty = baseline !== null && currentSnapshot !== baseline;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useImperativeHandle(ref, () => ({ save: () => handleSave(), reset: () => void fetchRates() }));

  // Nothing priced yet and nothing typed: the merchant's first useful click is one price for all of Egypt.
  const hasAnyRate =
    customRows.length > 0 ||
    Object.values(areaState).some(r => r.isActive || majorToMinor(r.feeMajor) > 0);

  // ── Export ────────────────────────────────────────────────────────────────

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await apiFetch(`/api/v1/stores/${storeId}/shipping/area-rates/export.xlsx`);
      if (!res.ok) {
        toastError(t('errorTitle'), t('exportFailed'));
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const match = cd.match(/filename="?([^"]+)"?/i);
      const filename = match?.[1] ?? 'shipping-area-rates.xlsx';
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toastError(t('errorTitle'), t('exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  // ── Import ────────────────────────────────────────────────────────────────

  async function postImportFile(file: File, dryRun: boolean) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('dryRun', String(dryRun));
    const res = await apiFetch(`/api/v1/stores/${storeId}/shipping/area-rates/import`, {
      method: 'POST',
      body: fd,
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error?.message ?? json?.message ?? 'import failed');
    }
    return json.data as ImportPreview & { upserted?: number };
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const data = await postImportFile(file, true);
      setPreview(data);
      setPendingFile(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('no rows')) {
        toastError(t('errorTitle'), t('noRowsFound'));
      } else if (msg.toLowerCase().includes('parse')) {
        toastError(t('errorTitle'), t('parseFailed'));
      } else {
        toastError(t('errorTitle'), t('importFailed'));
      }
    } finally {
      setImporting(false);
    }
  }

  async function confirmImport() {
    if (importing || !pendingFile) return;
    setImporting(true);
    try {
      const data = await postImportFile(pendingFile, false);
      toastSuccess(t('importedTitle'), t('importedDescription', { count: data.upserted ?? 0 }));
      setPreview(null);
      setPendingFile(null);
      fetchRates();
    } catch {
      toastError(t('errorTitle'), t('importFailed'));
    } finally {
      setImporting(false);
    }
  }

  function cancelImport() {
    setPreview(null);
    setPendingFile(null);
  }

  // ── Counts for accordion header ───────────────────────────────────────────

  function feeCount(govEn: string): number {
    const gov = EGYPT_GOVERNORATES.find(g => g.en === govEn);
    if (!gov) return 0;
    return gov.areas.filter(area => {
      const row = areaState[rowKey(govEn, area.en)];
      return row && (row.isActive || majorToMinor(row.feeMajor) > 0);
    }).length;
  }

  // ── Custom geography grouping helpers ─────────────────────────────────────

  /**
   * Returns unique custom countries. Egypt is NOT included here even if
   * there are custom areas added under Egypt governorates — those render
   * inside the static Egypt accordion.
   */
  function customCountries(): string[] {
    const seen = new Set<string>();
    for (const row of customRows) {
      if (row.country !== REGION.countryName.en) seen.add(row.country);
    }
    return Array.from(seen);
  }

  function customRowsForCountry(country: string): CustomRow[] {
    return customRows.filter(r => r.country === country);
  }

  /**
   * Custom areas that were added to a static Egypt governorate
   * (country === 'Egypt' but area is NOT in the static list for that gov).
   */
  function customAreasForEgyptGov(govEn: string): Array<{ row: CustomRow; idx: number }> {
    return customRows
      .map((row, idx) => ({ row, idx }))
      .filter(
        ({ row }) =>
          row.country === REGION.countryName.en &&
          row.governorate === govEn &&
          !EGYPT_GOVERNORATES.find(g => g.en === govEn)?.areas.some(a => a.en === row.area)
      );
  }

  function customRowsByGovernorate(country: string): string[] {
    const seen = new Set<string>();
    for (const row of customRows) {
      if (row.country === country) seen.add(row.governorate);
    }
    return Array.from(seen);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const ChevronIcon = ({ open }: { open: boolean }) => (
    <svg
      className={`w-5 h-5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );

  const TrashIcon = () => (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );

  return (
    <div className="space-y-4">
      {/* Export / import live in the overflow menu (rule 2): they are rare, one-time jobs. */}
      <div className="flex justify-end">
        <RowActions
          menuLabel={t('moreMenu')}
          items={[
            {
              label: exporting ? t('exporting') : t('exportBtn'),
              onSelect: handleExport,
              disabled: exporting,
            },
            {
              label: t('importBtn'),
              onSelect: () => fileInputRef.current?.click(),
              disabled: importing,
            },
          ]}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx"
          onChange={handleFileSelected}
          className="hidden"
        />
      </div>

      {/* First run: the common case is ONE price for all of Egypt, so offer it before 27 governorates. */}
      {!hasAnyRate && (
        <section
          data-testid="shipping-first-run"
          className="space-y-3 rounded-md border border-primary/30 bg-card p-5"
        >
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('firstRunTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('firstRunHint')}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              {t('firstRunFee')}
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder={t('firstRunFeePlaceholder')}
                  value={oneFee}
                  onChange={e => setOneFee(e.target.value)}
                  className={`${FIELD_CLASSES} w-28`}
                />
                <span>{t('currency')}</span>
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              {t('firstRunFreeOver')}
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder={t('firstRunFreeOverPlaceholder')}
                  value={oneThreshold}
                  onChange={e => setOneThreshold(e.target.value)}
                  className={`${FIELD_CLASSES} w-28`}
                />
                <span>{t('currency')}</span>
              </span>
            </label>
            <Button
              type="button"
              onClick={saveOnePrice}
              disabled={oneFee.trim() === '' || saving}
              variant="default"
            >
              {saving ? t('saving') : t('firstRunSave')}
            </Button>
          </div>
        </section>
      )}

      {/* Import preview modal */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-md border border-border bg-background p-5 shadow-xl space-y-4">
            <h3 className="text-lg font-semibold text-foreground">{t('previewTitle')}</h3>

            {preview.wouldUpsert > 0 ? (
              <p className="text-sm text-foreground">
                {t('previewWillUpdate', { count: preview.wouldUpsert })}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('previewNoValid')}</p>
            )}

            {preview.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-destructive-ink">
                  {t('previewErrors', { count: preview.errors.length })}
                </p>
                <ul className="max-h-40 overflow-y-auto text-xs text-muted-foreground space-y-0.5 border border-border rounded-lg p-2">
                  {preview.errors.map((err, i) => (
                    <li key={i}>
                      {t('rowLabel')} {err.row}: <span className="text-foreground">{err.area}</span>{' '}
                      — {err.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" onClick={cancelImport} disabled={importing} variant="outline">
                {t('cancel')}
              </Button>
              <Button
                type="button"
                onClick={confirmImport}
                disabled={importing || preview.wouldUpsert === 0}
                variant="default"
                className="gap-2"
              >
                {importing && (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                )}
                {importing ? t('importing') : t('confirmImport')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Global apply-to-all-areas control ───────────────────────────── */}
      <details className="rounded-md border border-border bg-muted/20 px-4 py-3" open={false}>
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          {t('applyAllGlobal')}
        </summary>
        <div className="mt-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-sm text-muted-foreground">{t('applyAllGlobalFee')}</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={globalBulkFeeMajor}
                  onChange={e => setGlobalBulkFeeMajor(e.target.value)}
                  aria-label={t('applyAllGlobalFee')}
                  className={`${FIELD_CLASSES} w-24 text-end`}
                />
                <span className="text-xs text-muted-foreground">{t('currency')}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm text-muted-foreground">
                {t('applyAllGlobalThreshold')}
              </label>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                  {t('freeOver')}
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={t('optional')}
                  value={globalBulkThresholdMajor}
                  onChange={e => setGlobalBulkThresholdMajor(e.target.value)}
                  aria-label={t('applyAllGlobalThreshold')}
                  className={`${FIELD_CLASSES} w-24 text-end`}
                />
                <span className="text-xs text-muted-foreground">{t('currency')}</span>
              </div>
            </div>
            <Button
              type="button"
              onClick={applyGlobalFee}
              disabled={globalBulkFeeMajor.trim() === ''}
              variant="default"
              size="sm"
            >
              {t('applyAllGlobalFeeBtn')}
            </Button>
            <Button
              type="button"
              onClick={applyGlobalThreshold}
              disabled={globalBulkThresholdMajor.trim() === ''}
              variant="outline"
              size="sm"
            >
              {t('applyAllGlobalThresholdBtn')}
            </Button>
          </div>
        </div>
      </details>

      <h2 className="pt-2 text-base font-semibold text-foreground">{t('perGovernorateTitle')}</h2>
      <p className="-mt-3 text-sm text-muted-foreground">{t('perGovernorateHint')}</p>

      {/* ── Static Egypt governorate accordion ─────────────────────────── */}
      <div className="divide-y divide-border rounded-md border border-border overflow-hidden">
        {EGYPT_GOVERNORATES.map(gov => {
          const isOpen = openGov === gov.en;
          const count = feeCount(gov.en);
          const customAreas = customAreasForEgyptGov(gov.en);
          const addKey = addAreaFormKey(REGION.countryName.en, gov.en);
          const addAreaIsOpen = addAreaOpen[addKey] ?? false;
          const addForm = addAreaForm[addKey] ?? { area: '', areaAr: '', feeMajor: '' };

          return (
            <div key={gov.en}>
              {/* Accordion header */}
              <button
                type="button"
                onClick={() => setOpenGov(isOpen ? null : gov.en)}
                data-ui="row"
                className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/70 transition-colors text-start"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-foreground">{isAr ? gov.ar : gov.en}</span>
                  {count > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary-ink">
                      {count} / {gov.areas.length}
                    </span>
                  )}
                  {customAreas.length > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary-ink">
                      +{customAreas.length}
                    </span>
                  )}
                </div>
                <ChevronIcon open={isOpen} />
              </button>

              {/* Accordion body */}
              {isOpen && (
                <div className="bg-background">
                  {/* Bulk-apply row (fee + free-over, decoupled) */}
                  <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-muted/20 border-b border-border">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {t('applyAll')}
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={bulkFeeMajor[gov.en] ?? ''}
                      onChange={e =>
                        setBulkFeeMajor(prev => ({ ...prev, [gov.en]: e.target.value }))
                      }
                      aria-label={t('applyAll')}
                      className={`${FIELD_CLASSES} w-24`}
                    />
                    <span className="text-xs text-muted-foreground">{t('currency')}</span>
                    <Button
                      type="button"
                      onClick={() => applyBulkFee(gov.en)}
                      variant="default"
                      size="sm"
                    >
                      {t('applyBtn')}
                    </Button>
                    {/* Free-over apply for this governorate (decoupled from fee) */}
                    <span className="text-xs text-muted-foreground whitespace-nowrap ms-2">
                      {t('freeOver')}
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={t('optional')}
                      value={bulkThresholdMajor[gov.en] ?? ''}
                      onChange={e =>
                        setBulkThresholdMajor(prev => ({ ...prev, [gov.en]: e.target.value }))
                      }
                      aria-label={t('freeOver')}
                      className={`${FIELD_CLASSES} w-24`}
                    />
                    <span className="text-xs text-muted-foreground">{t('currency')}</span>
                    <Button
                      type="button"
                      onClick={() => applyBulkThreshold(gov.en)}
                      disabled={(bulkThresholdMajor[gov.en] ?? '').trim() === ''}
                      variant="outline"
                      size="sm"
                    >
                      {t('applyBtn')}
                    </Button>
                  </div>

                  {/* Static area rows */}
                  <div className="divide-y divide-border/60">
                    {gov.areas.map(area => {
                      const k = rowKey(gov.en, area.en);
                      const row = areaState[k] ?? {
                        isActive: false,
                        feeMajor: '',
                        thresholdMajor: '',
                      };

                      return (
                        <div
                          key={area.en}
                          className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-2.5"
                        >
                          <Toggle
                            checked={row.isActive}
                            onChange={v => updateRow(k, { isActive: v })}
                            label={isAr ? area.ar : area.en}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-foreground">
                              {isAr ? area.ar : area.en}
                            </span>
                          </div>
                          <FeeInputs
                            feeMajor={row.feeMajor}
                            thresholdMajor={row.thresholdMajor}
                            onFeeChange={val =>
                              updateRow(k, {
                                feeMajor: val,
                                isActive: val !== '' ? true : row.isActive,
                              })
                            }
                            onThresholdChange={val => updateRow(k, { thresholdMajor: val })}
                            feeLabel={`${t('feeLabel')} – ${isAr ? area.ar : area.en}`}
                            freeOverLabel={`${t('freeOverLabel')} – ${isAr ? area.ar : area.en}`}
                            currencyLabel={t('currency')}
                            optionalLabel={t('optional')}
                            freeOverHint={t('freeOver')}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* Custom areas added to this Egypt governorate */}
                  {customAreas.length > 0 && (
                    <div className="border-t border-border/60">
                      <p className="px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/10">
                        {t('addedAreas')}
                      </p>
                      <div className="divide-y divide-border/40">
                        {customAreas.map(({ row, idx }) => (
                          <div
                            key={`custom-kw-${idx}`}
                            className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-2.5"
                          >
                            <Toggle
                              checked={row.isActive}
                              onChange={v => updateCustomRow(idx, { isActive: v })}
                              label={isAr && row.areaAr ? row.areaAr : row.area}
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-foreground">
                                {isAr && row.areaAr ? row.areaAr : row.area}
                              </span>
                            </div>
                            <FeeInputs
                              feeMajor={row.feeMajor}
                              thresholdMajor={row.thresholdMajor}
                              onFeeChange={val =>
                                updateCustomRow(idx, {
                                  feeMajor: val,
                                  isActive: val !== '' ? true : row.isActive,
                                })
                              }
                              onThresholdChange={val =>
                                updateCustomRow(idx, { thresholdMajor: val })
                              }
                              feeLabel={`${t('feeLabel')} – ${row.area}`}
                              freeOverLabel={`${t('freeOverLabel')} – ${row.area}`}
                              currencyLabel={t('currency')}
                              optionalLabel={t('optional')}
                              freeOverHint={t('freeOver')}
                            />
                            <Button
                              type="button"
                              onClick={() => removeCustomRow(idx)}
                              aria-label={`${t('remove')} ${row.area}`}
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground"
                            >
                              <TrashIcon />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Add area inline form for this Egypt governorate */}
                  <div className="border-t border-border/60 px-4 py-2">
                    {!addAreaIsOpen ? (
                      <Button
                        type="button"
                        onClick={() => toggleAddAreaForm(REGION.countryName.en, gov.en)}
                        variant="link"
                        size="sm"
                        className="gap-1"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 4v16m8-8H4"
                          />
                        </svg>
                        {t('addArea')}
                      </Button>
                    ) : (
                      <div className="flex flex-wrap items-end gap-2 py-1">
                        <div className="flex flex-col gap-1">
                          <label className="text-sm text-muted-foreground">{t('areaEn')}</label>
                          <input
                            type="text"
                            placeholder={t('areaNameEnSample')}
                            value={addForm.area}
                            onChange={e =>
                              setAddAreaForm(prev => ({
                                ...prev,
                                [addKey]: { ...addForm, area: e.target.value },
                              }))
                            }
                            className={`${FIELD_CLASSES} w-32`}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-sm text-muted-foreground">{t('areaAr')}</label>
                          <input
                            type="text"
                            placeholder={t('areaNameArSample')}
                            dir="rtl"
                            value={addForm.areaAr}
                            onChange={e =>
                              setAddAreaForm(prev => ({
                                ...prev,
                                [addKey]: { ...addForm, areaAr: e.target.value },
                              }))
                            }
                            className={`${FIELD_CLASSES} w-32`}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-sm text-muted-foreground">{t('feeLabel')}</label>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="0.00"
                              value={addForm.feeMajor}
                              onChange={e =>
                                setAddAreaForm(prev => ({
                                  ...prev,
                                  [addKey]: { ...addForm, feeMajor: e.target.value },
                                }))
                              }
                              className={`${FIELD_CLASSES} w-24 text-end`}
                            />
                            <span className="text-xs text-muted-foreground">{t('currency')}</span>
                          </div>
                        </div>
                        <Button
                          type="button"
                          onClick={() =>
                            submitAddArea(
                              REGION.countryName.en,
                              REGION.countryName.ar,
                              gov.en,
                              gov.ar
                            )
                          }
                          disabled={!addForm.area.trim()}
                          variant="default"
                          size="sm"
                        >
                          {t('addBtn')}
                        </Button>
                        <Button
                          type="button"
                          onClick={() => toggleAddAreaForm(REGION.countryName.en, gov.en)}
                          variant="outline"
                          size="sm"
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Custom countries ──────────────────────────────────────────────── */}
      {customCountries().map(country => {
        const countryRows = customRowsForCountry(country);
        const firstRow = countryRows[0];
        const countryAr = firstRow?.countryAr ?? '';
        const isOpen = openCustomCountry === country;
        const govs = customRowsByGovernorate(country);

        return (
          <div
            key={country}
            className="divide-y divide-border rounded-md border border-border overflow-hidden"
          >
            {/* Country header */}
            <button
              type="button"
              onClick={() => setOpenCustomCountry(isOpen ? null : country)}
              data-ui="row"
              className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/70 transition-colors text-start"
            >
              <div className="flex items-center gap-3">
                <span className="font-medium text-foreground">
                  {isAr && countryAr ? countryAr : country}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary-ink">
                  {countryRows.length}
                </span>
              </div>
              <ChevronIcon open={isOpen} />
            </button>

            {isOpen && (
              <div className="bg-background">
                {govs.map(gov => {
                  const govRows = countryRows.filter(r => r.governorate === gov);
                  const govAr = govRows[0]?.governorateAr ?? '';
                  const govAddKey = addAreaFormKey(country, gov);
                  const govAddOpen = addAreaOpen[govAddKey] ?? false;
                  const govAddForm = addAreaForm[govAddKey] ?? {
                    area: '',
                    areaAr: '',
                    feeMajor: '',
                  };

                  return (
                    <div key={gov} className="border-b border-border last:border-b-0">
                      {/* Governorate label */}
                      <div className="flex items-center gap-2 px-4 py-2 bg-muted/20">
                        <span className="text-sm font-medium text-foreground">
                          {isAr && govAr ? govAr : gov}
                        </span>
                      </div>

                      {/* Areas */}
                      <div className="divide-y divide-border/40">
                        {govRows.map(row => {
                          const idx = customRows.indexOf(row);
                          return (
                            <div
                              key={`${gov}||${row.area}`}
                              className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-2.5"
                            >
                              <Toggle
                                checked={row.isActive}
                                onChange={v => updateCustomRow(idx, { isActive: v })}
                                label={isAr && row.areaAr ? row.areaAr : row.area}
                              />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm text-foreground">
                                  {isAr && row.areaAr ? row.areaAr : row.area}
                                </span>
                              </div>
                              <FeeInputs
                                feeMajor={row.feeMajor}
                                thresholdMajor={row.thresholdMajor}
                                onFeeChange={val =>
                                  updateCustomRow(idx, {
                                    feeMajor: val,
                                    isActive: val !== '' ? true : row.isActive,
                                  })
                                }
                                onThresholdChange={val =>
                                  updateCustomRow(idx, { thresholdMajor: val })
                                }
                                feeLabel={`${t('feeLabel')} – ${row.area}`}
                                freeOverLabel={`${t('freeOverLabel')} – ${row.area}`}
                                currencyLabel={t('currency')}
                                optionalLabel={t('optional')}
                                freeOverHint={t('freeOver')}
                              />
                              <Button
                                type="button"
                                onClick={() => removeCustomRow(idx)}
                                aria-label={`${t('remove')} ${row.area}`}
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground"
                              >
                                <TrashIcon />
                              </Button>
                            </div>
                          );
                        })}
                      </div>

                      {/* Add area to this custom governorate */}
                      <div className="px-4 py-2">
                        {!govAddOpen ? (
                          <Button
                            type="button"
                            onClick={() => toggleAddAreaForm(country, gov)}
                            variant="link"
                            size="sm"
                            className="gap-1"
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 4v16m8-8H4"
                              />
                            </svg>
                            {t('addArea')}
                          </Button>
                        ) : (
                          <div className="flex flex-wrap items-end gap-2 py-1">
                            <div className="flex flex-col gap-1">
                              <label className="text-sm text-muted-foreground">{t('areaEn')}</label>
                              <input
                                type="text"
                                placeholder={t('areaNameEnSample')}
                                value={govAddForm.area}
                                onChange={e =>
                                  setAddAreaForm(prev => ({
                                    ...prev,
                                    [govAddKey]: { ...govAddForm, area: e.target.value },
                                  }))
                                }
                                className={`${FIELD_CLASSES} w-32`}
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-sm text-muted-foreground">{t('areaAr')}</label>
                              <input
                                type="text"
                                placeholder={t('areaNameArSample')}
                                dir="rtl"
                                value={govAddForm.areaAr}
                                onChange={e =>
                                  setAddAreaForm(prev => ({
                                    ...prev,
                                    [govAddKey]: { ...govAddForm, areaAr: e.target.value },
                                  }))
                                }
                                className={`${FIELD_CLASSES} w-32`}
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-sm text-muted-foreground">
                                {t('feeLabel')}
                              </label>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="0.00"
                                  value={govAddForm.feeMajor}
                                  onChange={e =>
                                    setAddAreaForm(prev => ({
                                      ...prev,
                                      [govAddKey]: { ...govAddForm, feeMajor: e.target.value },
                                    }))
                                  }
                                  className={`${FIELD_CLASSES} w-24 text-end`}
                                />
                                <span className="text-xs text-muted-foreground">
                                  {t('currency')}
                                </span>
                              </div>
                            </div>
                            <Button
                              type="button"
                              onClick={() => submitAddArea(country, countryAr, gov, govAr)}
                              disabled={!govAddForm.area.trim()}
                              variant="default"
                              size="sm"
                            >
                              {t('addBtn')}
                            </Button>
                            <Button
                              type="button"
                              onClick={() => toggleAddAreaForm(country, gov)}
                              variant="outline"
                              size="sm"
                            >
                              {t('cancel')}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* ── Add custom location panel ─────────────────────────────────────── */}
      <div className="rounded-md border border-dashed border-border overflow-hidden">
        <button
          type="button"
          onClick={() => setAddLocOpen(v => !v)}
          data-ui="row"
          className="w-full flex items-center justify-between px-4 py-3 bg-muted/20 hover:bg-muted/40 transition-colors text-start"
        >
          <div className="flex items-center gap-2">
            {!addLocOpen && (
              <svg
                className="w-4 h-4 text-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            )}
            <span className="text-sm font-medium text-foreground">{t('addCustomLocation')}</span>
          </div>
          <ChevronIcon open={addLocOpen} />
        </button>

        {addLocOpen && (
          <div className="bg-background p-4 space-y-4">
            <p className="text-xs text-muted-foreground">{t('addCustomLocationHint')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Country EN */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-foreground">{t('countryEn')} *</label>
                <input
                  type="text"
                  placeholder={t('countryEnSample')}
                  value={addLocForm.country}
                  onChange={e => setAddLocForm(prev => ({ ...prev, country: e.target.value }))}
                  className={FIELD_CLASSES}
                />
              </div>
              {/* Country AR */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-foreground">{t('countryAr')}</label>
                <input
                  type="text"
                  placeholder={t('countryArSample')}
                  dir="rtl"
                  value={addLocForm.countryAr}
                  onChange={e => setAddLocForm(prev => ({ ...prev, countryAr: e.target.value }))}
                  className={FIELD_CLASSES}
                />
              </div>
              {/* Governorate EN */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-foreground">
                  {t('governorateEn')} *
                </label>
                <input
                  type="text"
                  placeholder={t('cityEnSample')}
                  value={addLocForm.governorate}
                  onChange={e => setAddLocForm(prev => ({ ...prev, governorate: e.target.value }))}
                  className={FIELD_CLASSES}
                />
              </div>
              {/* Governorate AR */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-foreground">{t('governorateAr')}</label>
                <input
                  type="text"
                  placeholder={t('cityArSample')}
                  dir="rtl"
                  value={addLocForm.governorateAr}
                  onChange={e =>
                    setAddLocForm(prev => ({ ...prev, governorateAr: e.target.value }))
                  }
                  className={FIELD_CLASSES}
                />
              </div>
              {/* Area EN */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-foreground">{t('areaEn')} *</label>
                <input
                  type="text"
                  placeholder={t('districtEnSample')}
                  value={addLocForm.area}
                  onChange={e => setAddLocForm(prev => ({ ...prev, area: e.target.value }))}
                  className={FIELD_CLASSES}
                />
              </div>
              {/* Area AR */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-foreground">{t('areaAr')}</label>
                <input
                  type="text"
                  placeholder={t('districtArSample')}
                  dir="rtl"
                  value={addLocForm.areaAr}
                  onChange={e => setAddLocForm(prev => ({ ...prev, areaAr: e.target.value }))}
                  className={FIELD_CLASSES}
                />
              </div>
              {/* Fee */}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-foreground">{t('feeLabel')}</label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={addLocForm.feeMajor}
                    onChange={e => setAddLocForm(prev => ({ ...prev, feeMajor: e.target.value }))}
                    className={`${FIELD_CLASSES} w-28 text-end`}
                  />
                  <span className="text-xs text-muted-foreground">{t('currency')}</span>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                onClick={() => {
                  setAddLocOpen(false);
                  setAddLocForm({
                    country: '',
                    countryAr: '',
                    governorate: '',
                    governorateAr: '',
                    area: '',
                    areaAr: '',
                    feeMajor: '',
                  });
                }}
                variant="outline"
                size="sm"
              >
                {t('cancel')}
              </Button>
              <Button
                type="button"
                onClick={submitAddLoc}
                disabled={
                  !addLocForm.country.trim() ||
                  !addLocForm.governorate.trim() ||
                  !addLocForm.area.trim()
                }
                variant="default"
                size="sm"
              >
                {t('addBtn')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
