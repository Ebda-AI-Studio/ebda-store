'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../../lib/api';
import { textFieldValue } from '../../../../../lib/form-text';
import type { StoreBranding } from './types';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface Location {
  id: string;
  name: string;
  nameAr?: string | null;
  country: string;
  countryAr?: string | null;
  address: string;
  addressAr?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  mapsUrl?: string | null;
  mapsEmbedUrl?: string | null;
  hours?: string | null;
  hoursAr?: string | null;
  isPublished: boolean;
  position: number;
}

interface LocationFormData {
  name: string;
  nameAr: string;
  country: string;
  countryAr: string;
  address: string;
  addressAr: string;
  phone: string;
  whatsapp: string;
  mapsUrl: string;
  mapsEmbedUrl: string;
  hours: string;
  hoursAr: string;
  isPublished: boolean;
  position: number;
}

const EMPTY_FORM: LocationFormData = {
  name: '',
  nameAr: '',
  country: '',
  countryAr: '',
  address: '',
  addressAr: '',
  phone: '',
  whatsapp: '',
  mapsUrl: '',
  mapsEmbedUrl: '',
  hours: '',
  hoursAr: '',
  isPublished: true,
  position: 0,
};

interface StoreInfo {
  locationsEnabled?: boolean;
}

interface LocationsTabProps {
  storeId: string;
  /**
   * Shared branding state — the LocationsTab only reads/writes
   * `theme.showBranchesInFooter` from it (same shallow-merge PATCH pattern
   * as ThemeTab; the top-level page's "Save" button PUTs the whole object).
   */
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Admin locations CRUD page (Store Locations / Branches feature, 2026-06-16).
 *
 * Lists all locations (published + unpublished), inline create/edit form,
 * delete with inline confirm (no window.confirm), an Enable Locations toggle
 * that PUTs locationsEnabled to the store-update endpoint, and (2026-09-25,
 * B3) a "Show branches in footer" toggle on the shared theme state.
 *
 * Mirrors the blog list page structure and conventions exactly.
 */
export function LocationsTab({ storeId, branding, onChange }: LocationsTabProps) {
  const t = useT('branding.locations');
  const [locations, setLocations] = useState<Location[]>([]);
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Form state — null = closed, 'new' = create, string id = edit
  const [formMode, setFormMode] = useState<null | 'new' | string>(null);
  const [formData, setFormData] = useState<LocationFormData>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Inline delete confirm state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Enable-locations toggle state
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      const [locationsRes, storeRes] = await Promise.all([
        apiGet<{ locations: Location[] }>(`/api/v1/stores/${storeId}/locations`),
        apiGet<{ store: StoreInfo }>(`/api/v1/stores/${storeId}`),
      ]);
      if (cancelled) return;
      if (locationsRes.data?.locations) setLocations(locationsRes.data.locations);
      if (storeRes.data?.store) setStore(storeRes.data.store);
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  function openNew() {
    setFormData(EMPTY_FORM);
    setFormError(null);
    setFormMode('new');
  }

  function openEdit(loc: Location) {
    setFormData({
      name: loc.name,
      nameAr: loc.nameAr ?? '',
      country: loc.country,
      countryAr: loc.countryAr ?? '',
      address: loc.address,
      addressAr: loc.addressAr ?? '',
      phone: loc.phone ?? '',
      whatsapp: loc.whatsapp ?? '',
      mapsUrl: loc.mapsUrl ?? '',
      mapsEmbedUrl: loc.mapsEmbedUrl ?? '',
      hours: loc.hours ?? '',
      hoursAr: loc.hoursAr ?? '',
      isPublished: loc.isPublished,
      position: loc.position,
    });
    setFormError(null);
    setFormMode(loc.id);
  }

  function closeForm() {
    setFormMode(null);
    setFormError(null);
  }

  async function handleSave() {
    setIsSaving(true);
    setFormError(null);
    // This body is reused by the PUT (edit) branch below, so an emptied
    // optional field MUST send null — `undefined` omits the key and Prisma
    // then leaves the old value in place (the merchant can never clear it).
    const intent = formMode === 'new' ? 'create' : 'update';
    const body = {
      name: formData.name.trim(),
      nameAr: textFieldValue(formData.nameAr.trim(), intent),
      country: formData.country.trim(),
      countryAr: textFieldValue(formData.countryAr.trim(), intent),
      address: formData.address.trim(),
      addressAr: textFieldValue(formData.addressAr.trim(), intent),
      phone: textFieldValue(formData.phone.trim(), intent),
      whatsapp: textFieldValue(formData.whatsapp.trim(), intent),
      mapsUrl: textFieldValue(formData.mapsUrl.trim(), intent),
      mapsEmbedUrl: textFieldValue(formData.mapsEmbedUrl.trim(), intent),
      hours: textFieldValue(formData.hours.trim(), intent),
      hoursAr: textFieldValue(formData.hoursAr.trim(), intent),
      isPublished: formData.isPublished,
      position: formData.position,
    };

    if (formMode === 'new') {
      const { data, error } = await apiPost<{ location: Location }>(
        `/api/v1/stores/${storeId}/locations`,
        body
      );
      if (error) {
        setFormError(error.message || t('errCreate'));
      } else if (data?.location) {
        setLocations(prev => [...prev, data.location]);
        closeForm();
      }
    } else if (typeof formMode === 'string') {
      const { data, error } = await apiPut<{ location: Location }>(
        `/api/v1/stores/${storeId}/locations/${formMode}`,
        body
      );
      if (error) {
        setFormError(error.message || t('errUpdate'));
      } else if (data?.location) {
        setLocations(prev => prev.map(l => (l.id === formMode ? data.location : l)));
        closeForm();
      }
    }
    setIsSaving(false);
  }

  async function handleDelete(locationId: string) {
    setDeletingId(locationId);
    const { error } = await apiDelete(`/api/v1/stores/${storeId}/locations/${locationId}`);
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (!error) {
      setLocations(prev => prev.filter(l => l.id !== locationId));
    } else {
      // Surface delete error in a non-blocking way — set a temporary state
      // that auto-clears. No window.alert.
      setFormError(error.message || t('errDelete'));
    }
  }

  async function handleToggleEnabled() {
    if (!store) return;
    const next = !store.locationsEnabled;
    setIsTogglingEnabled(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}`, { locationsEnabled: next });
    setIsTogglingEnabled(false);
    if (!error) {
      setStore(prev => (prev ? { ...prev, locationsEnabled: next } : prev));
    }
  }

  const isEnabled = store?.locationsEnabled === true;

  const sortedLocations = [...locations].sort((a, b) => a.position - b.position);

  const locationColumns: DataTableColumn<Location>[] = [
    {
      header: t('colName'),
      primaryOnMobile: true,
      cell: loc => (
        <>
          <p className="font-medium text-foreground">{loc.name}</p>
          {loc.nameAr && (
            <p className="mt-0.5 text-xs text-muted-foreground" dir="rtl">
              {loc.nameAr}
            </p>
          )}
        </>
      ),
    },
    {
      header: t('colCountry'),
      hideOnMobile: true,
      className: 'hidden sm:table-cell',
      cell: loc => <span className="text-muted-foreground">{loc.country}</span>,
    },
    {
      header: t('colAddress'),
      hideOnMobile: true,
      className: 'hidden md:table-cell max-w-[200px] truncate',
      cell: loc => <span className="text-muted-foreground">{loc.address}</span>,
    },
    {
      header: t('colStatus'),
      mobileBadge: true,
      cell: loc => (
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
            loc.isPublished ? 'bg-success/10 text-success-ink' : 'bg-warning/10 text-warning-ink'
          }`}
        >
          {loc.isPublished ? t('statusPublished') : t('statusDraft')}
        </span>
      ),
    },
    {
      header: t('colPos'),
      cell: loc => <span className="text-muted-foreground">{loc.position}</span>,
    },
    {
      header: t('colActions'),
      alignEnd: true,
      mobileActions: true,
      cell: loc => (
        <div className="flex items-center justify-end gap-2">
          {/* Inline delete confirm */}
          {confirmDeleteId === loc.id ? (
            <>
              <span className="text-xs text-destructive-ink font-medium">{t('deleteConfirm')}</span>
              <Button
                variant="destructive"
                size="sm"
                type="button"
                disabled={deletingId === loc.id}
                onClick={() => handleDelete(loc.id)}
                className="font-semibold"
              >
                {deletingId === loc.id ? '…' : t('deleteYes')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="font-semibold"
              >
                {t('cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => openEdit(loc)}
                className="font-semibold"
              >
                {t('edit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => setConfirmDeleteId(loc.id)}
                className="font-semibold text-destructive-ink"
              >
                {t('delete')}
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Enable Locations toggle */}
      <div className="flex items-center justify-between rounded-md border bg-card p-4">
        <div>
          <p data-setting-id="branding.locations" className="text-sm font-semibold text-foreground">
            {t('enableTitle')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('enableDescription')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isEnabled}
          aria-label={t('enableTitle')}
          disabled={isTogglingEnabled || store === null}
          onClick={handleToggleEnabled}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
            isEnabled ? 'bg-primary' : 'bg-input'
          }`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-md ring-0 transition-transform ${
              isEnabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Show branches in footer — a separate opt-in from the page-level
          Enable Locations toggle above. Lives here (not Branding → Theme,
          which is capped at 7 toggles) because a merchant tuning branches
          looks at this tab, not the color/theme one. Reads/writes
          theme.showBranchesInFooter on the shared branding state; the page's
          top "Save" button PUTs it via the existing theme PATCH. */}
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border bg-card p-4">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">
            {t('showInFooterTitle')}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t('showInFooterHint')}
          </span>
        </span>
        <input
          type="checkbox"
          checked={branding.theme.showBranchesInFooter === true}
          onChange={e =>
            onChange({
              ...branding,
              theme: { ...branding.theme, showBranchesInFooter: e.target.checked },
            })
          }
          aria-label={t('showInFooterToggle')}
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

      {/* Locations not enabled callout */}
      {store && !isEnabled && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <p className="font-semibold text-warning-ink">{t('disabledTitle')}</p>
          <p className="mt-1 text-warning-ink">{t('disabledDescription')}</p>
        </div>
      )}

      {/* Nav placement hint */}
      {store && isEnabled && (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {t('navHint')}
        </p>
      )}

      {/* Top actions bar */}
      {formMode === null && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {!isLoading && t('count', { count: locations.length })}
          </p>
          <Button type="button" onClick={openNew}>
            {t('addButton')}
          </Button>
        </div>
      )}

      {/* Inline form — Create / Edit */}
      {formMode !== null && (
        <div className="rounded-md border bg-card p-5 space-y-4">
          <h3 className="text-base font-semibold text-foreground">
            {formMode === 'new' ? t('formNewTitle') : t('formEditTitle')}
          </h3>

          {formError && (
            <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive-ink">
              {formError}
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Name EN */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldName')} <span className="text-destructive-ink">*</span>
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                placeholder={t('phName')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Name AR */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldNameAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.nameAr}
                onChange={e => setFormData(p => ({ ...p, nameAr: e.target.value }))}
                placeholder={t('phNameAr')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Country EN */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldCountry')} <span className="text-destructive-ink">*</span>
              </label>
              <input
                type="text"
                value={formData.country}
                onChange={e => setFormData(p => ({ ...p, country: e.target.value }))}
                placeholder={t('phCountry')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Country AR */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldCountryAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.countryAr}
                onChange={e => setFormData(p => ({ ...p, countryAr: e.target.value }))}
                placeholder={t('phCountryAr')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Address EN */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldAddress')} <span className="text-destructive-ink">*</span>
              </label>
              <input
                type="text"
                value={formData.address}
                onChange={e => setFormData(p => ({ ...p, address: e.target.value }))}
                placeholder={t('phAddress')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Address AR */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldAddressAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.addressAr}
                onChange={e => setFormData(p => ({ ...p, addressAr: e.target.value }))}
                placeholder={t('phAddressAr')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Phone */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">{t('fieldPhone')}</label>
              <input
                type="tel"
                value={formData.phone}
                onChange={e => setFormData(p => ({ ...p, phone: e.target.value }))}
                placeholder={t('phPhone')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* WhatsApp */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldWhatsapp')}
              </label>
              <input
                type="tel"
                value={formData.whatsapp}
                onChange={e => setFormData(p => ({ ...p, whatsapp: e.target.value }))}
                placeholder={t('phWhatsapp')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Hours EN */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">{t('fieldHours')}</label>
              <input
                type="text"
                value={formData.hours}
                onChange={e => setFormData(p => ({ ...p, hours: e.target.value }))}
                placeholder={t('phHours')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Hours AR */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldHoursAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.hoursAr}
                onChange={e => setFormData(p => ({ ...p, hoursAr: e.target.value }))}
                placeholder={t('phHoursAr')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Maps URL */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldMapsUrl')}
              </label>
              <input
                type="url"
                value={formData.mapsUrl}
                onChange={e => setFormData(p => ({ ...p, mapsUrl: e.target.value }))}
                placeholder={t('phMapsUrl')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Maps Embed URL */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldMapsEmbedUrl')}
              </label>
              <input
                type="url"
                value={formData.mapsEmbedUrl}
                onChange={e => setFormData(p => ({ ...p, mapsEmbedUrl: e.target.value }))}
                placeholder={t('phMapsEmbedUrl')}
                className={FIELD_CLASSES}
              />
            </div>
            {/* Position */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-foreground">
                {t('fieldPosition')}
              </label>
              <input
                type="number"
                min={0}
                max={10000}
                value={formData.position}
                onChange={e =>
                  setFormData(p => ({ ...p, position: parseInt(e.target.value, 10) || 0 }))
                }
                className={FIELD_CLASSES}
              />
            </div>
          </div>

          {/* Published toggle */}
          <div className="flex items-center gap-3">
            <input
              id="loc-published"
              type="checkbox"
              checked={formData.isPublished}
              onChange={e => setFormData(p => ({ ...p, isPublished: e.target.checked }))}
              className="h-5 w-5 rounded-md border-input text-primary focus:ring-ring"
            />
            <label htmlFor="loc-published" className="text-sm text-foreground">
              {t('fieldPublished')}
            </label>
          </div>

          {/* Form actions */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={isSaving}
              onClick={handleSave}
              className="font-semibold"
            >
              {isSaving ? t('saving') : formMode === 'new' ? t('create') : t('save')}
            </Button>
            <Button variant="outline" type="button" onClick={closeForm} className="font-semibold">
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* Locations table */}
      {isLoading ? (
        <div className="rounded-md border bg-card">
          <ul className="divide-y">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 p-4 animate-pulse">
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 rounded-md bg-muted" />
                  <div className="h-3 w-1/3 rounded-md bg-muted" />
                </div>
                <div className="hidden h-7 w-16 shrink-0 rounded-md bg-muted sm:block" />
              </li>
            ))}
          </ul>
        </div>
      ) : locations.length === 0 ? (
        <div className="rounded-md border bg-card">
          <div className="p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6"
                aria-hidden
              >
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                <circle cx="12" cy="9" r="2.5" />
              </svg>
            </div>
            <p className="text-base font-semibold text-foreground">{t('emptyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('emptyDescription')}</p>
            {formMode === null && (
              <Button type="button" onClick={openNew} className="mt-4 gap-2 font-semibold">
                {t('emptyCta')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <DataTable<Location>
          ariaLabel={t('tableLabel')}
          columns={locationColumns}
          rows={sortedLocations}
          rowKey={loc => loc.id}
        />
      )}

      {/* Generic error (e.g. from delete) when form is closed */}
      {formError && formMode === null && (
        <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive-ink">
          {formError}
        </p>
      )}
    </div>
  );
}
