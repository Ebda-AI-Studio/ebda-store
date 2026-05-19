'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPatch } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Supplier {
  id: string;
  name: string;
  nameAr: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  paymentTerms: string;
  customTermsDays: number | null;
  notes: string | null;
  notesAr: string | null;
}

interface SupplierResponse {
  data: Supplier;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PAYMENT_TERMS = ['net0', 'net15', 'net30', 'net60', 'custom'] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewSupplierPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT('stock.suppliers');
  const tNew = useT('stock.suppliers.new');

  const supplierId = searchParams?.get('supplierId') ?? null;
  const isEdit = !!supplierId;

  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [paymentTerms, setPaymentTerms] = useState<string>('net30');
  const [customTermsDays, setCustomTermsDays] = useState('');
  const [notes, setNotes] = useState('');
  const [notesAr, setNotesAr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (!isEdit || !storeId || !supplierId) return;
    apiGet<SupplierResponse>(`/api/v1/stores/${storeId}/suppliers/${supplierId}`).then(
      ({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (data?.data) {
          const s = data.data;
          setName(s.name);
          setNameAr(s.nameAr ?? '');
          setContactName(s.contactName ?? '');
          setPhone(s.phone ?? '');
          setEmail(s.email ?? '');
          setPaymentTerms(s.paymentTerms);
          setCustomTermsDays(s.customTermsDays?.toString() ?? '');
          setNotes(s.notes ?? '');
          setNotesAr(s.notesAr ?? '');
        }
        setLoading(false);
      }
    );
  }, [isEdit, storeId, supplierId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSubmitting(true);
    setError(null);

    const payload = {
      name: name.trim(),
      nameAr: nameAr.trim() || undefined,
      contactName: contactName.trim() || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      paymentTerms,
      customTermsDays:
        paymentTerms === 'custom' && customTermsDays ? parseInt(customTermsDays) : undefined,
      notes: notes.trim() || undefined,
      notesAr: notesAr.trim() || undefined,
    };

    try {
      const { error: apiError } = isEdit
        ? await apiPatch(`/api/v1/stores/${storeId}/suppliers/${supplierId}`, payload)
        : await apiPost(`/api/v1/stores/${storeId}/suppliers`, payload);

      if (apiError) {
        setError(apiError.message);
        return;
      }
      router.push(`/stores/${storeId}/stock/suppliers`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <AdminLayout title={tNew('title')}>
        <div className="p-6 text-muted-foreground text-sm">Loading…</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={tNew('title')}>
      <form onSubmit={handleSubmit} className="max-w-2xl space-y-5">
        {/* Name + NameAr */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">
              {t('name')} <span className="text-red-500">*</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder="e.g. Al-Mutlaq Trading"
            />
          </label>
          <label className="space-y-1" dir="rtl">
            <span className="text-sm font-medium">الاسم (عربي)</span>
            <input
              type="text"
              value={nameAr}
              onChange={e => setNameAr(e.target.value)}
              dir="rtl"
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder="اسم المورد بالعربية"
            />
          </label>
        </div>

        {/* ContactName / Phone / Email */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">{t('contact')}</span>
            <input
              type="text"
              value={contactName}
              onChange={e => setContactName(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder="Contact person"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">{t('phone')}</span>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder="+965 …"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">{t('email')}</span>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder="supplier@example.com"
            />
          </label>
        </div>

        {/* Payment terms */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">{t('paymentTerms')}</span>
            <select
              value={paymentTerms}
              onChange={e => setPaymentTerms(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            >
              {PAYMENT_TERMS.map(pt => (
                <option key={pt} value={pt}>
                  {t(`terms.${pt}`)}
                </option>
              ))}
            </select>
          </label>

          {paymentTerms === 'custom' && (
            <label className="space-y-1">
              <span className="text-sm font-medium">{tNew('customTermsDays')}</span>
              <input
                type="number"
                min="1"
                step="1"
                value={customTermsDays}
                onChange={e => setCustomTermsDays(e.target.value)}
                className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
                placeholder="e.g. 45"
              />
            </label>
          )}
        </div>

        {/* Notes + NotesAr */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">{tNew('notes')}</span>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
              placeholder="Optional notes in English"
            />
          </label>
          <label className="space-y-1" dir="rtl">
            <span className="text-sm font-medium">{tNew('notesAr')}</span>
            <textarea
              value={notesAr}
              onChange={e => setNotesAr(e.target.value)}
              rows={3}
              dir="rtl"
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
              placeholder="ملاحظات بالعربية (اختياري)"
            />
          </label>
        </div>

        {error && <div className="text-red-600 text-sm">{error}</div>}

        <div className="flex gap-2 flex-wrap">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
          >
            {submitting ? 'Saving…' : tNew('submit')}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/stock/suppliers`)}
            className="px-4 py-2 border border-border rounded text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    </AdminLayout>
  );
}
