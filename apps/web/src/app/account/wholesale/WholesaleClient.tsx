'use client';

/**
 * Wholesale account (B2B Task 6 / Task 5): apply, see the decision. The applicant is the signed-in customer (the API reads the
 * session; this form sends no user id). Arabic first copy via `t(en, ar)`, Latin digits.
 */
import { useEffect, useState } from 'react';
import { Button } from '@ebda/ui';
import { api } from '@/lib/api';
import { useLanguage } from '../../../contexts/LanguageContext';

type Status = Awaited<ReturnType<typeof api.getWholesaleStatus>>;

export default function WholesaleClient() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<NonNullable<Status['data']> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ businessName: '', commercialRegNo: '', phone: '', notes: '' });

  const load = async () => {
    const res = await api.getWholesaleStatus();
    if (res.success && res.data) setStatus(res.data);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);

  const messageFor = (code?: string, fallback?: string) => {
    switch (code) {
      case 'ALREADY_PENDING':
        return t(
          'You already have an application waiting for review.',
          'لديك طلب قيد المراجعة بالفعل.'
        );
      case 'ALREADY_APPROVED':
        return t('Your account already has wholesale access.', 'حسابك لديه صلاحية الجملة بالفعل.');
      case 'REAPPLY_COOLDOWN':
        return t(
          'You can apply again 30 days after a rejection.',
          'يمكنك التقديم مرة أخرى بعد 30 يومًا من الرفض.'
        );
      case 'EMAIL_NOT_VERIFIED':
        return t(
          'Verify your email address before applying.',
          'يرجى تأكيد بريدك الإلكتروني قبل التقديم.'
        );
      case 'FEATURE_DISABLED':
        return t(
          'This store does not offer wholesale accounts.',
          'هذا المتجر لا يقدّم حسابات الجملة.'
        );
      default:
        return (
          fallback ||
          t('Something went wrong. Please try again.', 'حدث خطأ ما. يرجى المحاولة مرة أخرى.')
        );
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.applyForWholesale({
      businessName: form.businessName.trim(),
      commercialRegNo: form.commercialRegNo.trim() || null,
      phone: form.phone.trim(),
      notes: form.notes.trim() || null,
    });
    if (!res.success) setError(messageFor(res.error?.code, res.error?.message));
    else await load();
    setBusy(false);
  };

  if (loading)
    return (
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    );

  const app = status?.application;
  const canApply =
    !status?.isWholesale && (!app || app.status === 'rejected' || app.status === 'revoked');

  return (
    <div className="max-w-xl space-y-4" data-testid="wholesale-account">
      <h1 className="text-xl font-semibold">{t('Wholesale account', 'حساب الجملة')}</h1>

      {status?.isWholesale ? (
        <p className="rounded-lg bg-primary/10 p-3 text-sm">
          {t(
            'Your account has wholesale access. Your wholesale prices appear on products, in your cart and at checkout.',
            'حسابك لديه صلاحية الجملة. تظهر أسعار الجملة على المنتجات وفي السلة وعند إتمام الطلب.'
          )}
        </p>
      ) : null}

      {app?.status === 'pending' ? (
        <p className="rounded-lg bg-muted p-3 text-sm">
          {t('Your application for', 'طلبك الخاص بـ')} <bdi>{app.businessName}</bdi>{' '}
          {t('is waiting for the store to review it.', 'قيد مراجعة المتجر.')}
        </p>
      ) : null}
      {app?.status === 'rejected' ? (
        <p className="rounded-lg bg-destructive/10 p-3 text-sm">
          {t('Your last application was not approved.', 'لم تتم الموافقة على طلبك الأخير.')}{' '}
          {app.decisionNote ? <bdi>{app.decisionNote}</bdi> : null}
        </p>
      ) : null}

      {canApply ? (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">
            {t('Business name', 'اسم النشاط التجاري')}
            <input
              required
              minLength={2}
              maxLength={160}
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={form.businessName}
              onChange={e => setForm({ ...form, businessName: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t('Commercial registration no. (optional)', 'رقم السجل التجاري (اختياري)')}
            <input
              maxLength={60}
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={form.commercialRegNo}
              onChange={e => setForm({ ...form, commercialRegNo: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t('Business phone', 'هاتف النشاط')}
            <input
              required
              type="tel"
              minLength={6}
              maxLength={40}
              dir="ltr"
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t('Notes (optional)', 'ملاحظات (اختياري)')}
            <textarea
              maxLength={1000}
              rows={3}
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive-ink">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy
              ? t('Sending...', 'جارٍ الإرسال...')
              : t('Apply for a wholesale account', 'التقديم على حساب جملة')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
