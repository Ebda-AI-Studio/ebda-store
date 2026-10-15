'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Select, useToast } from '@ebda/ui';
import { Sheet } from '../../../components/ui/Sheet';
import { api } from '@/lib/api';
import { useAuth } from '../../../contexts/AuthContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useStoreUrl } from '../../../contexts/StoreContext';

import { REGION, areasForGovernorate, orderAddressLines } from '@ebda/shared';
interface Address {
  id: string;
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  governorate?: string;
  governorateAr?: string;
  area?: string;
  areaAr?: string;
  street?: string | null;
  building?: string | null;
  floor?: string | null;
  apartment?: string | null;
  postalCode?: string;
  country: string;
  phone?: string;
  isDefault: boolean;
}

const EMPTY_FORM = {
  firstName: '',
  lastName: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  governorate: '',
  governorateAr: '',
  area: '',
  areaAr: '',
  street: '',
  building: '',
  floor: '',
  apartment: '',
  postalCode: '',
  country: REGION.countryName.en,
  phone: '',
  isDefault: false,
};

export default function AddressesClient() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { success, error: toastError } = useToast();
  const { t, language } = useLanguage();
  const storeUrl = useStoreUrl();

  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push(storeUrl('/auth/login?redirect=/account/addresses'));
    }
  }, [isAuthenticated, authLoading, router]);

  const fetchAddresses = useCallback(async () => {
    try {
      const result = await api.get<{ addresses: Address[] }>('/addresses');
      if (result.success && result.data) {
        setAddresses(result.data.addresses || []);
      }
    } catch {
      // Silently fail - user may not have any addresses yet
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      fetchAddresses();
    }
  }, [isAuthenticated, fetchAddresses]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);

    try {
      const endpoint = editingId ? `/addresses/${editingId}` : '/addresses';
      const method = editingId ? 'put' : 'post';

      // address1 is the composed street line (same shape as checkout) so every
      // order/invoice/label reader keeps working; the structured parts ride along.
      const address1 = [
        formData.street.trim(),
        formData.building.trim() && `${t('Building', 'عمارة')} ${formData.building.trim()}`,
        formData.floor.trim() && `${t('Floor', 'دور')} ${formData.floor.trim()}`,
        formData.apartment.trim() && `${t('Apt', 'شقة')} ${formData.apartment.trim()}`,
      ]
        .filter(Boolean)
        .join(language === 'ar' ? '، ' : ', ');
      const payload = {
        ...formData,
        address1,
        country: REGION.countryName.en,
        postalCode: '',
      };

      const result = await api[method]<{ address: Address }>(endpoint, payload);

      if (result.success) {
        success(
          editingId
            ? t('Address updated', 'تم تحديث العنوان')
            : t('Address added', 'تمت إضافة العنوان'),
          editingId
            ? t('Your address has been updated.', 'تم تحديث عنوانك.')
            : t('New address has been saved.', 'تم حفظ العنوان الجديد.')
        );
        fetchAddresses();
        resetForm();
      } else {
        toastError(
          t('Error', 'خطأ'),
          result.error?.message || t('Failed to save address', 'تعذر حفظ العنوان')
        );
      }
    } catch {
      toastError(t('Error', 'خطأ'), t('An unexpected error occurred.', 'حدث خطأ غير متوقع.'));
    } finally {
      setIsSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTargetId) return;
    setIsDeleting(true);
    try {
      const result = await api.delete(`/addresses/${deleteTargetId}`);
      if (result.success) {
        setAddresses(prev => prev.filter(a => a.id !== deleteTargetId));
        success(
          t('Address deleted', 'تم حذف العنوان'),
          t('The address has been removed.', 'تمت إزالة العنوان.')
        );
      } else {
        toastError(t('Error', 'خطأ'), t('Failed to delete address', 'تعذر حذف العنوان'));
      }
    } catch {
      toastError(t('Error', 'خطأ'), t('An unexpected error occurred.', 'حدث خطأ غير متوقع.'));
    } finally {
      setIsDeleting(false);
      setDeleteTargetId(null);
    }
  }

  async function handleSetDefault(id: string) {
    try {
      const result = await api.put(`/addresses/${id}`, { isDefault: true });
      if (result.success) {
        setAddresses(prev => prev.map(a => ({ ...a, isDefault: a.id === id })));
        success(
          t('Default updated', 'تم تحديث العنوان الافتراضي'),
          t('Default address has been changed.', 'تم تغيير العنوان الافتراضي.')
        );
      }
    } catch {
      toastError(
        t('Error', 'خطأ'),
        t('Failed to update default address', 'تعذر تحديث العنوان الافتراضي')
      );
    }
  }

  function startEdit(address: Address) {
    setEditingId(address.id);
    setFormData({
      firstName: address.firstName,
      lastName: address.lastName,
      address1: address.address1,
      // address2 holds the landmark («علامة مميزة»), same as checkout.
      address2: address.address2 || '',
      city: address.city,
      state: address.state,
      governorate: address.governorate || address.state,
      governorateAr: address.governorateAr || '',
      area: address.area || '',
      areaAr: address.areaAr || '',
      // Older saved addresses only have the composed address1 line.
      street: address.street || address.address1 || '',
      building: address.building || '',
      floor: address.floor || '',
      apartment: address.apartment || '',
      postalCode: address.postalCode || '',
      country: address.country,
      phone: address.phone || '',
      isDefault: address.isDefault,
    });
    setIsAdding(true);
  }

  function resetForm() {
    setIsAdding(false);
    setEditingId(null);
    setFormData(EMPTY_FORM);
  }

  const areaOptions = areasForGovernorate(formData.governorate);

  if (isLoading || authLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-foreground">
          {t(
            'Saved Addresses',
            '\u0627\u0644\u0639\u0646\u0627\u0648\u064a\u0646 \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629'
          )}
        </h1>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t(
              'Saved Addresses',
              '\u0627\u0644\u0639\u0646\u0627\u0648\u064a\u0646 \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629'
            )}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t(
              'Manage your delivery addresses',
              '\u0625\u062f\u0627\u0631\u0629 \u0639\u0646\u0627\u0648\u064a\u0646 \u0627\u0644\u062a\u0648\u0635\u064a\u0644'
            )}
          </p>
        </div>
        {!isAdding && (
          <Button onClick={() => setIsAdding(true)}>
            <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('Add Address', '\u0625\u0636\u0627\u0641\u0629 \u0639\u0646\u0648\u0627\u0646')}
          </Button>
        )}
      </div>

      {isAdding && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-foreground">
            {editingId
              ? t(
                  'Edit Address',
                  '\u062a\u0639\u062f\u064a\u0644 \u0627\u0644\u0639\u0646\u0648\u0627\u0646'
                )
              : t(
                  'Add New Address',
                  '\u0625\u0636\u0627\u0641\u0629 \u0639\u0646\u0648\u0627\u0646 \u062c\u062f\u064a\u062f'
                )}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t(
                  'First Name',
                  '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u0648\u0644'
                )}
                value={formData.firstName}
                onChange={e => setFormData({ ...formData, firstName: e.target.value })}
                required
              />
              <Input
                label={t(
                  'Last Name',
                  '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u062e\u064a\u0631'
                )}
                value={formData.lastName}
                onChange={e => setFormData({ ...formData, lastName: e.target.value })}
                required
              />
            </div>

            <Input
              label={t('Phone Number', '\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062a\u0641')}
              type="tel"
              value={formData.phone}
              onChange={e => setFormData({ ...formData, phone: e.target.value })}
              placeholder={REGION.phone.placeholderIntl}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label={t('Governorate', 'المحافظة')}
                value={formData.governorate}
                onChange={e => {
                  // `state` is NOT NULL in the DB and what older readers use; mirror the governorate.
                  const gov = REGION.governorates.find(g => g.nameEn === e.target.value);
                  setFormData({
                    ...formData,
                    governorate: e.target.value,
                    governorateAr: gov?.nameAr ?? '',
                    state: e.target.value,
                    area: '',
                    areaAr: '',
                  });
                }}
                options={[
                  { value: '', label: t('Select…', 'اختر…') },
                  ...REGION.governorates.map(g => ({
                    value: g.nameEn,
                    label: t(g.nameEn, g.nameAr),
                  })),
                ]}
                required
              />
              {areaOptions.length > 0 ? (
                <Select
                  label={t('Area', 'المنطقة')}
                  value={formData.area}
                  onChange={e => {
                    const picked = areaOptions.find(a => a.en === e.target.value);
                    setFormData({
                      ...formData,
                      area: e.target.value,
                      areaAr: picked?.ar ?? '',
                    });
                  }}
                  options={[
                    { value: '', label: t('Select…', 'اختر…') },
                    ...areaOptions.map(a => ({ value: a.en, label: t(a.en, a.ar) })),
                  ]}
                  required
                />
              ) : (
                <Input
                  label={t('Area', 'المنطقة')}
                  value={formData.area}
                  onChange={e => setFormData({ ...formData, area: e.target.value, areaAr: '' })}
                  disabled={!formData.governorate}
                  required
                />
              )}
            </div>

            <Input
              label={t('Street', 'الشارع')}
              value={formData.street}
              onChange={e => setFormData({ ...formData, street: e.target.value })}
              required
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label={t('Building (optional)', 'رقم العمارة (اختياري)')}
                value={formData.building}
                onChange={e => setFormData({ ...formData, building: e.target.value })}
              />
              <Input
                label={t('Floor (optional)', 'الدور (اختياري)')}
                value={formData.floor}
                onChange={e => setFormData({ ...formData, floor: e.target.value })}
              />
              <Input
                label={t('Apartment (optional)', 'الشقة (اختياري)')}
                value={formData.apartment}
                onChange={e => setFormData({ ...formData, apartment: e.target.value })}
              />
            </div>

            <Input
              label={t('Landmark (optional)', 'علامة مميزة (اختياري)')}
              value={formData.address2}
              onChange={e => setFormData({ ...formData, address2: e.target.value })}
              placeholder={t('Next to the pharmacy…', 'بجوار الصيدلية…')}
            />

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.isDefault}
                onChange={e => setFormData({ ...formData, isDefault: e.target.checked })}
                className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
              />
              <span className="text-sm text-foreground">
                {t(
                  'Set as default address',
                  '\u062a\u0639\u064a\u064a\u0646 \u0643\u0639\u0646\u0648\u0627\u0646 \u0627\u0641\u062a\u0631\u0627\u0636\u064a'
                )}
              </span>
            </label>

            <div className="flex gap-2 pt-4">
              <Button type="submit" isLoading={isSaving}>
                {editingId
                  ? t(
                      'Update Address',
                      '\u062a\u062d\u062f\u064a\u062b \u0627\u0644\u0639\u0646\u0648\u0627\u0646'
                    )
                  : t(
                      'Save Address',
                      '\u062d\u0641\u0638 \u0627\u0644\u0639\u0646\u0648\u0627\u0646'
                    )}
              </Button>
              <Button type="button" variant="outline" onClick={resetForm}>
                {t('Cancel', '\u0625\u0644\u063a\u0627\u0621')}
              </Button>
            </div>
          </form>
        </div>
      )}

      {addresses.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {addresses.map(address => (
            <div
              key={address.id}
              className={`relative rounded-xl border bg-card p-6 shadow-sm ${
                address.isDefault ? 'border-primary' : ''
              }`}
            >
              {address.isDefault && (
                <span className="absolute right-4 top-4 rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  {t('Default', '\u0627\u0644\u0627\u0641\u062a\u0631\u0627\u0636\u064a')}
                </span>
              )}
              <p className="font-medium text-foreground">
                {address.firstName} {address.lastName}
              </p>
              {orderAddressLines(address as unknown as Record<string, unknown>, language).map(
                (line, i) => (
                  <p key={i} className={`text-sm text-muted-foreground ${i === 0 ? 'mt-1' : ''}`}>
                    {line}
                  </p>
                )
              )}
              {address.phone && (
                <p className="mt-2 text-sm text-muted-foreground">{address.phone}</p>
              )}

              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => startEdit(address)}
                  className="text-sm text-primary hover:underline"
                >
                  {t('Edit', '\u062a\u0639\u062f\u064a\u0644')}
                </button>
                {!address.isDefault && (
                  <button
                    onClick={() => handleSetDefault(address.id)}
                    className="text-sm text-primary hover:underline"
                  >
                    {t(
                      'Set as Default',
                      '\u062a\u0639\u064a\u064a\u0646 \u0643\u0627\u0641\u062a\u0631\u0627\u0636\u064a'
                    )}
                  </button>
                )}
                <button
                  onClick={() => setDeleteTargetId(address.id)}
                  className="text-sm text-destructive-ink hover:underline"
                >
                  {t('Delete', '\u062d\u0630\u0641')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !isAdding ? (
        <div className="rounded-xl border bg-card p-12 text-center shadow-sm">
          <svg
            className="mx-auto h-12 w-12 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-foreground">
            {t(
              'No addresses saved',
              '\u0644\u0627 \u062a\u0648\u062c\u062f \u0639\u0646\u0627\u0648\u064a\u0646 \u0645\u062d\u0641\u0648\u0638\u0629'
            )}
          </h3>
          <p className="mt-2 text-muted-foreground">
            {t(
              'Add an address for faster checkout.',
              '\u0623\u0636\u0641 \u0639\u0646\u0648\u0627\u0646\u0627\u064b \u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u0634\u0631\u0627\u0621 \u0628\u0634\u0643\u0644 \u0623\u0633\u0631\u0639.'
            )}
          </p>
          <Button onClick={() => setIsAdding(true)} className="mt-6">
            {t(
              'Add Your First Address',
              '\u0623\u0636\u0641 \u0639\u0646\u0648\u0627\u0646\u0643 \u0627\u0644\u0623\u0648\u0644'
            )}
          </Button>
        </div>
      ) : null}

      {/* The shared Sheet primitive (R-04 fix round), centred like the old Modal. */}
      <Sheet
        open={!!deleteTargetId}
        onClose={() => (isDeleting ? undefined : setDeleteTargetId(null))}
        side="center"
        title={t('Delete address', 'حذف العنوان')}
        closeLabel={t('Close', 'إغلاق')}
        className="bg-background text-foreground"
        bodyClassName="px-5 pb-5"
      >
        <p className="text-sm text-muted-foreground">
          {t(
            'This address will be removed permanently. You can add a new one anytime.',
            'سيتم حذف هذا العنوان نهائيًا. يمكنك إضافة عنوان جديد في أي وقت.'
          )}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setDeleteTargetId(null)} disabled={isDeleting}>
            {t('Cancel', 'إلغاء')}
          </Button>
          <Button variant="destructive" onClick={confirmDelete} disabled={isDeleting}>
            {isDeleting ? t('Deleting…', 'جاري الحذف…') : t('Delete', 'حذف')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
