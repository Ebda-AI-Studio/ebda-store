'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@force/ui';
import { api } from '@/lib/api';
import { useAuth } from '../../../contexts/AuthContext';
import { useLanguage } from '../../../contexts/LanguageContext';

interface Address {
  id: string;
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  area?: string;
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
  area: '',
  postalCode: '',
  country: 'Kuwait',
  phone: '',
  isDefault: false,
};

export default function AddressesPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { success, error: toastError } = useToast();
  const { t } = useLanguage();

  const [addresses, setAddresses] = useState<Address[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/auth/login?redirect=/account/addresses');
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

      const result = await api[method]<{ address: Address }>(endpoint, formData);

      if (result.success) {
        success(
          editingId ? 'Address updated' : 'Address added',
          editingId ? 'Your address has been updated.' : 'New address has been saved.'
        );
        fetchAddresses();
        resetForm();
      } else {
        toastError('Error', result.error?.message || 'Failed to save address');
      }
    } catch {
      toastError('Error', 'An unexpected error occurred.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const result = await api.delete(`/addresses/${id}`);
      if (result.success) {
        setAddresses(prev => prev.filter(a => a.id !== id));
        success('Address deleted', 'The address has been removed.');
      } else {
        toastError('Error', 'Failed to delete address');
      }
    } catch {
      toastError('Error', 'An unexpected error occurred.');
    }
  }

  async function handleSetDefault(id: string) {
    try {
      const result = await api.put(`/addresses/${id}`, { isDefault: true });
      if (result.success) {
        setAddresses(prev => prev.map(a => ({ ...a, isDefault: a.id === id })));
        success('Default updated', 'Default address has been changed.');
      }
    } catch {
      toastError('Error', 'Failed to update default address');
    }
  }

  function startEdit(address: Address) {
    setEditingId(address.id);
    setFormData({
      firstName: address.firstName,
      lastName: address.lastName,
      address1: address.address1,
      address2: address.address2 || '',
      city: address.city,
      state: address.state,
      area: address.area || '',
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

  if (isLoading || authLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {t('Saved Addresses', 'العناوين المحفوظة')}
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
          <h1 className="text-2xl font-bold text-gray-900">
            {t('Saved Addresses', 'العناوين المحفوظة')}
          </h1>
          <p className="mt-1 text-gray-500">
            {t('Manage your delivery addresses', 'إدارة عناوين التوصيل')}
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
            {t('Add Address', 'إضافة عنوان')}
          </Button>
        )}
      </div>

      {isAdding && (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">
            {editingId
              ? t('Edit Address', 'تعديل العنوان')
              : t('Add New Address', 'إضافة عنوان جديد')}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t('First Name', 'الاسم الأول')}
                value={formData.firstName}
                onChange={e => setFormData({ ...formData, firstName: e.target.value })}
                required
              />
              <Input
                label={t('Last Name', 'الاسم الأخير')}
                value={formData.lastName}
                onChange={e => setFormData({ ...formData, lastName: e.target.value })}
                required
              />
            </div>

            <Input
              label={t('Phone Number', 'رقم الهاتف')}
              type="tel"
              value={formData.phone}
              onChange={e => setFormData({ ...formData, phone: e.target.value })}
              placeholder="+965 XXXX XXXX"
            />

            <Input
              label={t('Street Address', 'عنوان الشارع')}
              value={formData.address1}
              onChange={e => setFormData({ ...formData, address1: e.target.value })}
              required
            />

            <Input
              label={t('Apt / Suite / Building (optional)', 'شقة / جناح / مبنى (اختياري)')}
              value={formData.address2}
              onChange={e => setFormData({ ...formData, address2: e.target.value })}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label={t('City', 'المدينة')}
                value={formData.city}
                onChange={e => setFormData({ ...formData, city: e.target.value })}
                required
              />
              <Input
                label={t('State / Area', 'المنطقة')}
                value={formData.state}
                onChange={e => setFormData({ ...formData, state: e.target.value })}
                required
              />
              <Input
                label={t('Postal Code', 'الرمز البريدي')}
                value={formData.postalCode}
                onChange={e => setFormData({ ...formData, postalCode: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                {t('Country', 'الدولة')}
              </label>
              <select
                value={formData.country}
                onChange={e => setFormData({ ...formData, country: e.target.value })}
                className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="Kuwait">Kuwait</option>
                <option value="Saudi Arabia">Saudi Arabia</option>
                <option value="UAE">United Arab Emirates</option>
                <option value="Bahrain">Bahrain</option>
                <option value="Qatar">Qatar</option>
                <option value="Oman">Oman</option>
              </select>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.isDefault}
                onChange={e => setFormData({ ...formData, isDefault: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
              <span className="text-sm text-gray-700">
                {t('Set as default address', 'تعيين كعنوان افتراضي')}
              </span>
            </label>

            <div className="flex gap-2 pt-4">
              <Button type="submit" isLoading={isSaving}>
                {editingId
                  ? t('Update Address', 'تحديث العنوان')
                  : t('Save Address', 'حفظ العنوان')}
              </Button>
              <Button type="button" variant="outline" onClick={resetForm}>
                {t('Cancel', 'إلغاء')}
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
              className={`relative rounded-xl border bg-white p-6 shadow-sm ${
                address.isDefault ? 'border-primary' : ''
              }`}
            >
              {address.isDefault && (
                <span className="absolute right-4 top-4 rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  {t('Default', 'الافتراضي')}
                </span>
              )}
              <p className="font-medium text-gray-900">
                {address.firstName} {address.lastName}
              </p>
              <p className="mt-1 text-sm text-gray-600">{address.address1}</p>
              {address.address2 && <p className="text-sm text-gray-600">{address.address2}</p>}
              <p className="text-sm text-gray-600">
                {address.city}, {address.state} {address.postalCode}
              </p>
              <p className="text-sm text-gray-600">{address.country}</p>
              {address.phone && <p className="mt-2 text-sm text-gray-500">{address.phone}</p>}

              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => startEdit(address)}
                  className="text-sm text-primary hover:underline"
                >
                  {t('Edit', 'تعديل')}
                </button>
                {!address.isDefault && (
                  <button
                    onClick={() => handleSetDefault(address.id)}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('Set as Default', 'تعيين كافتراضي')}
                  </button>
                )}
                <button
                  onClick={() => handleDelete(address.id)}
                  className="text-sm text-red-600 hover:underline"
                >
                  {t('Delete', 'حذف')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !isAdding ? (
        <div className="rounded-xl border bg-white p-12 text-center shadow-sm">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
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
          <h3 className="mt-4 text-lg font-medium text-gray-900">
            {t('No addresses saved', 'لا توجد عناوين محفوظة')}
          </h3>
          <p className="mt-2 text-gray-500">
            {t('Add an address for faster checkout.', 'أضف عنواناً لإتمام الشراء بشكل أسرع.')}
          </p>
          <Button onClick={() => setIsAdding(true)} className="mt-6">
            {t('Add Your First Address', 'أضف عنوانك الأول')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
