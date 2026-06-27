'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../../lib/api';

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

/**
 * Admin locations CRUD page (Store Locations / Branches feature, 2026-06-16).
 *
 * Lists all locations (published + unpublished), inline create/edit form,
 * delete with inline confirm (no window.confirm), and an Enable Locations
 * toggle that PUTs locationsEnabled to the store-update endpoint.
 *
 * Mirrors the blog list page structure and conventions exactly.
 */
export function LocationsTab({ storeId }: { storeId: string }) {
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
    const body = {
      name: formData.name.trim(),
      nameAr: formData.nameAr.trim() || undefined,
      country: formData.country.trim(),
      countryAr: formData.countryAr.trim() || undefined,
      address: formData.address.trim(),
      addressAr: formData.addressAr.trim() || undefined,
      phone: formData.phone.trim() || undefined,
      whatsapp: formData.whatsapp.trim() || undefined,
      mapsUrl: formData.mapsUrl.trim() || undefined,
      mapsEmbedUrl: formData.mapsEmbedUrl.trim() || undefined,
      hours: formData.hours.trim() || undefined,
      hoursAr: formData.hoursAr.trim() || undefined,
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

  return (
    <div className="space-y-6">
      {/* Enable Locations toggle */}
      <div className="flex items-center justify-between rounded-xl border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('enableTitle')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('enableDescription')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isEnabled}
          disabled={isTogglingEnabled || store === null}
          onClick={handleToggleEnabled}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
            isEnabled ? 'bg-primary' : 'bg-input'
          }`}
        >
          <span
            className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
              isEnabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Locations not enabled callout */}
      {store && !isEnabled && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">{t('disabledTitle')}</p>
          <p className="mt-1 text-amber-800">{t('disabledDescription')}</p>
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
          <button
            type="button"
            onClick={openNew}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
          >
            {t('addButton')}
          </button>
        </div>
      )}

      {/* Inline form — Create / Edit */}
      {formMode !== null && (
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <h3 className="text-base font-semibold text-foreground">
            {formMode === 'new' ? t('formNewTitle') : t('formEditTitle')}
          </h3>

          {formError && (
            <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {formError}
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Name EN */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldName')} <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                placeholder={t('phName')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Name AR */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldNameAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.nameAr}
                onChange={e => setFormData(p => ({ ...p, nameAr: e.target.value }))}
                placeholder={t('phNameAr')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Country EN */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldCountry')} <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                value={formData.country}
                onChange={e => setFormData(p => ({ ...p, country: e.target.value }))}
                placeholder={t('phCountry')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Country AR */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldCountryAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.countryAr}
                onChange={e => setFormData(p => ({ ...p, countryAr: e.target.value }))}
                placeholder={t('phCountryAr')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Address EN */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldAddress')} <span className="text-destructive">*</span>
              </label>
              <input
                type="text"
                value={formData.address}
                onChange={e => setFormData(p => ({ ...p, address: e.target.value }))}
                placeholder={t('phAddress')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Address AR */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldAddressAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.addressAr}
                onChange={e => setFormData(p => ({ ...p, addressAr: e.target.value }))}
                placeholder={t('phAddressAr')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Phone */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">{t('fieldPhone')}</label>
              <input
                type="tel"
                value={formData.phone}
                onChange={e => setFormData(p => ({ ...p, phone: e.target.value }))}
                placeholder={t('phPhone')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* WhatsApp */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldWhatsapp')}
              </label>
              <input
                type="tel"
                value={formData.whatsapp}
                onChange={e => setFormData(p => ({ ...p, whatsapp: e.target.value }))}
                placeholder={t('phWhatsapp')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Hours EN */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">{t('fieldHours')}</label>
              <input
                type="text"
                value={formData.hours}
                onChange={e => setFormData(p => ({ ...p, hours: e.target.value }))}
                placeholder={t('phHours')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Hours AR */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldHoursAr')}
              </label>
              <input
                type="text"
                dir="rtl"
                value={formData.hoursAr}
                onChange={e => setFormData(p => ({ ...p, hoursAr: e.target.value }))}
                placeholder={t('phHoursAr')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Maps URL */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldMapsUrl')}
              </label>
              <input
                type="url"
                value={formData.mapsUrl}
                onChange={e => setFormData(p => ({ ...p, mapsUrl: e.target.value }))}
                placeholder={t('phMapsUrl')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Maps Embed URL */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
                {t('fieldMapsEmbedUrl')}
              </label>
              <input
                type="url"
                value={formData.mapsEmbedUrl}
                onChange={e => setFormData(p => ({ ...p, mapsEmbedUrl: e.target.value }))}
                placeholder={t('phMapsEmbedUrl')}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {/* Position */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-foreground">
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
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
              className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
            />
            <label htmlFor="loc-published" className="text-sm text-foreground">
              {t('fieldPublished')}
            </label>
          </div>

          {/* Form actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={handleSave}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
            >
              {isSaving ? t('saving') : formMode === 'new' ? t('create') : t('save')}
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Locations table */}
      <div className="rounded-xl border bg-card">
        {isLoading ? (
          <ul className="divide-y">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 p-4 animate-pulse">
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 rounded bg-muted" />
                  <div className="h-3 w-1/3 rounded bg-muted" />
                </div>
                <div className="hidden h-7 w-16 shrink-0 rounded bg-muted sm:block" />
              </li>
            ))}
          </ul>
        ) : locations.length === 0 ? (
          <div className="p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
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
              <button
                type="button"
                onClick={openNew}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                {t('emptyCta')}
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t('colName')}</th>
                  <th className="hidden px-4 py-3 sm:table-cell">{t('colCountry')}</th>
                  <th className="hidden px-4 py-3 md:table-cell">{t('colAddress')}</th>
                  <th className="px-4 py-3">{t('colStatus')}</th>
                  <th className="px-4 py-3">{t('colPos')}</th>
                  <th className="px-4 py-3 text-right">{t('colActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[...locations]
                  .sort((a, b) => a.position - b.position)
                  .map(loc => (
                    <tr key={loc.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{loc.name}</p>
                        {loc.nameAr && (
                          <p className="mt-0.5 text-xs text-muted-foreground" dir="rtl">
                            {loc.nameAr}
                          </p>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                        {loc.country}
                      </td>
                      <td className="hidden max-w-[200px] truncate px-4 py-3 text-muted-foreground md:table-cell">
                        {loc.address}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            loc.isPublished
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {loc.isPublished ? t('statusPublished') : t('statusDraft')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{loc.position}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {/* Inline delete confirm */}
                          {confirmDeleteId === loc.id ? (
                            <>
                              <span className="text-xs text-destructive font-medium">
                                {t('deleteConfirm')}
                              </span>
                              <button
                                type="button"
                                disabled={deletingId === loc.id}
                                onClick={() => handleDelete(loc.id)}
                                className="inline-flex items-center rounded-lg bg-destructive px-2.5 py-1 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
                              >
                                {deletingId === loc.id ? '…' : t('deleteYes')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="inline-flex items-center rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-muted"
                              >
                                {t('cancel')}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => openEdit(loc)}
                                className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
                              >
                                {t('edit')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(loc.id)}
                                className="inline-flex items-center rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
                              >
                                {t('delete')}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Generic error (e.g. from delete) when form is closed */}
      {formError && formMode === null && (
        <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {formError}
        </p>
      )}
    </div>
  );
}
