'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { HelpTip } from '@/components/HelpTip';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPatch } from '@/lib/api';
import { numericFieldValue, textFieldValue } from '@/lib/form-text';

import { REGION } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
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
  leadTimeDays: number;
  notes: string | null;
  notesAr: string | null;
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
  const tCommon = useT('common');

  const supplierId = searchParams?.get('supplierId') ?? null;
  const isEdit = !!supplierId;

  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [paymentTerms, setPaymentTerms] = useState<string>('net30');
  const [customTermsDays, setCustomTermsDays] = useState('');
  const [leadTimeDays, setLeadTimeDays] = useState('7');
  const [notes, setNotes] = useState('');
  const [notesAr, setNotesAr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (!isEdit || !storeId || !supplierId) return;
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the supplier — reading `data?.data` double-unwrapped to
    // undefined and the edit form never populated (#831 sweep).
    apiGet<Supplier>(`/api/v1/stores/${storeId}/suppliers/${supplierId}`).then(
      ({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (data) {
          const s = data;
          setName(s.name);
          setNameAr(s.nameAr ?? '');
          setContactName(s.contactName ?? '');
          setPhone(s.phone ?? '');
          setEmail(s.email ?? '');
          setPaymentTerms(s.paymentTerms);
          setCustomTermsDays(s.customTermsDays?.toString() ?? '');
          setLeadTimeDays(s.leadTimeDays?.toString() ?? '7');
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
      setError(t('nameRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);

    // textFieldValue sends `null` on update (clears the stored value) and
    // `undefined` on create (nothing to clear yet) — this page shares one
    // payload between apiPost (create) and apiPatch (edit) below, so a plain
    // `X || undefined` made clearing any of these fields on an existing
    // supplier impossible (#1576, the same class as the shipped
    // order-invoice-email bug).
    const intent = isEdit ? 'update' : 'create';
    const payload = {
      name: name.trim(),
      nameAr: textFieldValue(nameAr.trim(), intent),
      contactName: textFieldValue(contactName.trim(), intent),
      phone: textFieldValue(phone.trim(), intent),
      email: textFieldValue(email.trim(), intent),
      paymentTerms,
      // Only meaningful for custom terms. On update, switching AWAY from
      // custom sends null so the stale day count is cleared (issue 2262) —
      // `cond ? n : undefined` dropped the key and kept it forever.
      customTermsDays: numericFieldValue(
        paymentTerms === 'custom' ? customTermsDays : '',
        intent,
        v => parseInt(v, 10)
      ),
      leadTimeDays: leadTimeDays ? parseInt(leadTimeDays) : 7,
      notes: textFieldValue(notes.trim(), intent),
      notesAr: textFieldValue(notesAr.trim(), intent),
    };

    try {
      const { error: apiError } = isEdit
        ? await apiPatch(`/api/v1/stores/${storeId}/suppliers/${supplierId}`, payload)
        : await apiPost(`/api/v1/stores/${storeId}/suppliers`, payload);

      if (apiError) {
        setError(apiError.message);
        return;
      }
      // Invalidate the App Router cache so the suppliers list re-fetches and
      // shows the just-created/edited supplier (without this, navigating back
      // serves the cached list and the new row appears missing until a hard reload).
      router.refresh();
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
        <div className="p-6 text-muted-foreground text-sm">{tCommon('loading')}</div>
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
              placeholder={t('supplierNameEnSample')}
            />
          </label>
          <label className="space-y-1" dir="rtl">
            <span className="text-sm font-medium">{t('nameArLabel')}</span>
            <input
              type="text"
              value={nameAr}
              onChange={e => setNameAr(e.target.value)}
              dir="rtl"
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder={t('supplierNameArPlaceholder')}
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
              placeholder={t('contactPlaceholder')}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">{t('phone')}</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder={REGION.phone.placeholderIntl}
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
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium">{t('paymentTerms')}</span>
              <HelpTip text={tNew('paymentTermsTip')} />
            </div>
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
          </div>

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
                placeholder={t('termsDaysExample')}
              />
            </label>
          )}
        </div>

        {/* Net lead time */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium">{tNew('leadTimeDays')}</span>
              <HelpTip text={tNew('leadTimeDaysTip')} />
            </div>
            <input
              type="number"
              min="1"
              max="365"
              step="1"
              value={leadTimeDays}
              onChange={e => setLeadTimeDays(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              placeholder="7"
            />
          </label>
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
              placeholder={t('notesEnPlaceholder')}
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
              placeholder={t('notesArPlaceholder')}
            />
          </label>
        </div>

        {error && <div className="text-red-600 text-sm">{error}</div>}

        <div className="flex gap-2 flex-wrap">
          <Button type="submit" disabled={submitting} variant="default">
            {submitting ? tCommon('saving') : tNew('submit')}
          </Button>
          <Button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/stock/suppliers`)}
            variant="outline"
          >
            {tCommon('cancel')}
          </Button>
        </div>
      </form>
    </AdminLayout>
  );
}
