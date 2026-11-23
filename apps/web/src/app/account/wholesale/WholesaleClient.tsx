'use client';

/**
 * Wholesale account (B2B Task 6 / Task 5): apply, see the decision. The applicant is the signed-in customer (the API reads the
 * session; this form sends no user id). Arabic first copy via `t(en, ar)`, Latin digits.
 */
import { useEffect, useState } from 'react';
import Link from '../../../components/StoreLink';
import { Button } from '@ebda/ui';
import { api } from '@/lib/api';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useLocalePrice } from '../../../hooks/useLocalePrice';

type Status = Awaited<ReturnType<typeof api.getWholesaleStatus>>;
type CatalogProduct = NonNullable<
  Awaited<ReturnType<typeof api.getWholesaleProducts>>['data']
>['products'][number];

// 16px on a phone: under that, iOS Safari zooms the page on focus. The label around it is text-sm.
const INPUT = 'mt-1 min-h-11 w-full rounded-md border px-3 py-2 text-base sm:text-sm';

export default function WholesaleClient() {
  const { t } = useLanguage();
  const formatPrice = useLocalePrice();
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [consent, setConsent] = useState(false);
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
  // I2: an approved buyer lists the wholesale-only products here (the storefront catalogue never contains them).
  useEffect(() => {
    if (!status?.isWholesale) return;
    let cancelled = false;
    void api
      .getWholesaleProducts({ limit: 24 })
      .then(res => {
        if (!cancelled && res.success && res.data) setCatalog(res.data.products);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status?.isWholesale]);

  const messageFor = (code?: string, fallback?: string) => {
    switch (code) {
      case 'ALREADY_PENDING':
        return t('You already have an application waiting for review.', 'عندك طلب لسه بيتراجع.');
      case 'ALREADY_APPROVED':
        return t('Your account already has wholesale access.', 'حسابك فيه صلاحية الجملة أصلًا.');
      case 'REAPPLY_COOLDOWN':
        return t(
          'You can apply again 30 days after the decision on your last application.',
          'تقدر تقدّم تاني بعد 30 يوم من قرار طلبك الأخير.'
        );
      case 'EMAIL_NOT_VERIFIED':
        return t(
          'Verify your email address before applying.',
          'أكّد بريدك الإلكتروني الأول وبعدها قدّم.'
        );
      case 'FEATURE_DISABLED':
        return t(
          'This store does not offer wholesale accounts.',
          'المتجر ده مش بيقدّم حسابات جملة.'
        );
      default:
        return fallback || t('Something went wrong. Please try again.', 'حصلت مشكلة. جرّب تاني.');
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
      consent: true,
    });
    if (!res.success) setError(messageFor(res.error?.code, res.error?.message));
    else await load();
    setBusy(false);
  };

  if (loading)
    return (
      <div
        role="status"
        aria-label={t('Loading', 'بيحمّل')}
        className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"
      />
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
            'حسابك فيه صلاحية الجملة. أسعار الجملة بتظهر على المنتجات وفي السلة وعند إتمام الطلب.'
          )}
        </p>
      ) : null}
      {/* approved, but the wholesale group is no longer active: say so instead of rendering nothing */}
      {app?.status === 'approved' && !status?.isWholesale ? (
        <p className="rounded-lg bg-muted p-3 text-sm">
          {t(
            'Your application was approved, but wholesale access is paused on this account right now. Contact the store.',
            'طلبك اتوافق عليه، بس صلاحية الجملة موقوفة على حسابك دلوقتي. كلّم المتجر.'
          )}
        </p>
      ) : null}
      {app?.status === 'revoked' ? (
        <p className="rounded-lg bg-muted p-3 text-sm">
          {t(
            'Your wholesale access was ended by the store.',
            'المتجر أنهى صلاحية الجملة على حسابك.'
          )}{' '}
          {app.decisionNote ? <bdi>{app.decisionNote}</bdi> : null}
        </p>
      ) : null}

      {app?.status === 'pending' ? (
        <p className="rounded-lg bg-muted p-3 text-sm">
          {t('Your application for', 'طلبك الخاص بـ')} <bdi>{app.businessName}</bdi>{' '}
          {t('is waiting for the store to review it.', 'لسه المتجر بيراجعه.')}
        </p>
      ) : null}
      {app?.status === 'rejected' ? (
        <p className="rounded-lg bg-destructive/10 p-3 text-sm">
          {t('Your last application was not approved.', 'طلبك الأخير اتّرفض.')}{' '}
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
              className={INPUT}
              value={form.businessName}
              onChange={e => setForm({ ...form, businessName: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t('Commercial registration no. (optional)', 'رقم السجل التجاري (اختياري)')}
            <input
              maxLength={60}
              className={INPUT}
              value={form.commercialRegNo}
              onChange={e => setForm({ ...form, commercialRegNo: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t('Business phone', 'هاتف النشاط')}
            <input
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              minLength={6}
              maxLength={40}
              dir="ltr"
              className={INPUT}
              value={form.phone}
              onChange={e => setForm({ ...form, phone: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t('Notes (optional, no ID numbers please)', 'ملاحظات (اختياري، دون أرقام هوية)')}
            <textarea
              maxLength={1000}
              rows={3}
              className={INPUT}
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          <label className="flex items-start gap-3 text-sm" data-testid="wholesale-consent">
            <input
              type="checkbox"
              required
              checked={consent}
              onChange={e => setConsent(e.target.checked)}
              className="mt-1 h-5 w-5 shrink-0"
            />
            <span>
              {t(
                'I agree that the store keeps these details (business name, phone, registration number, notes) to review my application and manage my wholesale account, and deletes them if I ask. ',
                'أوافق على أن يحتفظ المتجر بهذه البيانات (اسم النشاط، الهاتف، رقم السجل، الملاحظات) لمراجعة طلبي وإدارة حساب الجملة، وأن يحذفها عند طلبي. '
              )}
              <Link href="/privacy" className="underline">
                {t('Privacy policy', 'سياسة الخصوصية')}
              </Link>
            </span>
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive-ink">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || !consent} className="min-h-11">
            {busy
              ? t('Sending...', 'بيتبعت...')
              : t('Apply for a wholesale account', 'التقديم على حساب جملة')}
          </Button>
        </form>
      ) : null}
      {status?.isWholesale && catalog.length > 0 ? (
        <section aria-labelledby="wholesale-catalog-title" data-testid="wholesale-catalog">
          <h2 id="wholesale-catalog-title" className="mt-6 text-lg font-semibold">
            {t('Wholesale-only products', 'منتجات للجملة بس')}
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {catalog.map(p => (
              <li key={p.id} className="rounded-lg border p-3">
                <Link
                  href={`/products/${encodeURIComponent(p.slug)}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  <bdi>{p.name}</bdi>
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatPrice(p.price)}
                  {p.moq ? ` - ${t(`minimum order ${p.moq}`, `الحد الأدنى للطلب ${p.moq}`)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
