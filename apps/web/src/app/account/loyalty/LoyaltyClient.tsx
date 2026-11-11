'use client';

import { storeNumerals } from '@ebda/shared';
import { useState, useEffect } from 'react';
import { useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useNumerals } from '../../../hooks/useNumerals';
import { useFeatures } from '../../../contexts/FeatureContext';
import { api, API_URL } from '../../../lib/api';
import { formatDate as formatStoreDate } from '../../../lib/format-date';
import { useToast, SignedNumber } from '@ebda/ui';

interface LoyaltyPoints {
  points: number;
  tier?: string;
  enabled?: boolean;
}

interface LoyaltyTransaction {
  id: string;
  type: string;
  points: number;
  description?: string;
  createdAt: string;
}

/** Fetch wrapper that sends auth cookies. */
async function authFetch(url: string) {
  return fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
}

export default function LoyaltyClient() {
  const { store } = useStore();
  const { t, language } = useLanguage();
  const { localize } = useNumerals();
  const { isEnabled } = useFeatures();
  const { success: toastSuccess, error: toastError } = useToast();
  const storeId = store.id;

  // Tenant-aware wrapper around the shared formatter so the JSX below
  // can stay terse. Loyalty rows show date only (no time) — picks the
  // long preset to keep the existing visual.
  const formatDate = (dateStr: string) =>
    formatStoreDate(dateStr, {
      timezone: store.timezone,
      language,
      numerals: storeNumerals(store?.theme),
      style: 'long',
    });

  const [loyaltyPoints, setLoyaltyPoints] = useState<LoyaltyPoints | null>(null);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [isLoadingPoints, setIsLoadingPoints] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loyaltyDisabled, setLoyaltyDisabled] = useState(false);
  /** true when the customer has no loyalty record yet (not yet enrolled) */
  const [notEnrolled, setNotEnrolled] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  useEffect(() => {
    // Guard: do not attempt to fetch until we have a real store id
    if (!storeId || storeId === 'demo') return;

    async function fetchPoints() {
      setIsLoadingPoints(true);
      setPointsError(null);
      setNotEnrolled(false);
      try {
        const res = await authFetch(`${API_URL}/public/${storeId}/loyalty/my-points`);
        const json = await res.json();

        if (res.status === 404 || json?.error?.code === 'LOYALTY_DISABLED') {
          setLoyaltyDisabled(true);
          return;
        }

        if (res.ok && json.success) {
          const pointsData = json.data?.points ?? json.data ?? json;
          if (pointsData === null || pointsData === undefined) {
            // Loyalty is enabled for this store (feature gate in layout ensures
            // this page is only reachable when loyalty is active) but the
            // customer has no loyalty record yet — show the join CTA.
            if (isEnabled('loyalty')) {
              setNotEnrolled(true);
            } else {
              setLoyaltyDisabled(true);
            }
          } else {
            setLoyaltyPoints(pointsData);
          }
        } else {
          setPointsError(json.error?.message || 'Failed to load loyalty points.');
        }
      } catch {
        setPointsError('Unable to load loyalty points. Please check your connection.');
      } finally {
        setIsLoadingPoints(false);
      }
    }

    async function fetchHistory() {
      setIsLoadingHistory(true);
      setHistoryError(null);
      try {
        const res = await authFetch(`${API_URL}/public/${storeId}/loyalty/my-transactions`);
        const json = await res.json();

        if (res.status === 404 || json?.error?.code === 'LOYALTY_DISABLED') {
          // Handled by points fetch
          return;
        }

        if (res.ok && json.success) {
          const txns = json.data?.transactions ?? json.data?.history ?? json.transactions ?? [];
          setTransactions(txns);
        } else {
          setHistoryError(json.error?.message || 'Failed to load transaction history.');
        }
      } catch {
        setHistoryError('Unable to load transaction history. Please check your connection.');
      } finally {
        setIsLoadingHistory(false);
      }
    }

    fetchPoints();
    fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, isEnabled]);

  // Derive tier badge color
  function tierColor(tier?: string) {
    switch (tier?.toLowerCase()) {
      case 'gold':
        return 'bg-warning/20 text-warning-ink';
      case 'silver':
        return 'bg-muted text-foreground';
      case 'platinum':
        return 'bg-info/10 text-info-ink';
      default:
        return 'bg-info/20 text-info-ink';
    }
  }

  /** Enrol the customer in the loyalty program and refresh the page state. */
  async function handleJoin() {
    if (!storeId || storeId === 'demo' || isJoining) return;
    setIsJoining(true);
    try {
      const result = await api.joinLoyalty(storeId);
      if (result.success && result.data) {
        toastSuccess(
          t('Welcome to the loyalty program!', 'أهلاً بيك في برنامج الولاء!'),
          t(
            'Your points balance has been created. Start earning on every order.',
            'حسابك في برنامج النقط جاهز. ابدأ اكسب نقط مع كل طلب.'
          )
        );
        // Re-fetch to pick up the new record (includes the signup bonus).
        setNotEnrolled(false);
        setIsLoadingPoints(true);
        setIsLoadingHistory(true);
        const res = await authFetch(`${API_URL}/public/${storeId}/loyalty/my-points`);
        const json = await res.json();
        if (res.ok && json.success) {
          const pointsData = json.data?.points ?? json.data ?? json;
          if (pointsData !== null && pointsData !== undefined) {
            setLoyaltyPoints(pointsData);
          }
        }
        setIsLoadingPoints(false);
        // Refresh transaction history too so the signup-bonus row appears.
        const txRes = await authFetch(`${API_URL}/public/${storeId}/loyalty/my-transactions`);
        const txJson = await txRes.json();
        if (txRes.ok && txJson.success) {
          const txns =
            txJson.data?.transactions ?? txJson.data?.history ?? txJson.transactions ?? [];
          setTransactions(txns);
        }
        setIsLoadingHistory(false);
      } else {
        const msg =
          result.error?.message ||
          t('Failed to join. Please try again.', 'الانضمام منفعش. جرّب تاني.');
        toastError(t('Could not join', 'معرفناش نسجّلك'), msg);
      }
    } catch {
      toastError(
        t('Could not join', 'معرفناش نسجّلك'),
        t('An unexpected error occurred. Please try again.', 'حصل خطأ مش متوقع. جرّب تاني.')
      );
    } finally {
      setIsJoining(false);
    }
  }

  if (!storeId || storeId === 'demo') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t('Loyalty Program', 'برنامج الولاء')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t('Your points and rewards', 'نقطك ومكافآتك')}
          </p>
        </div>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (loyaltyDisabled) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t('Loyalty Program', 'برنامج الولاء')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t('Your points and rewards', 'نقطك ومكافآتك')}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-10 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <svg
              className="h-7 w-7 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-foreground">
            {t('Loyalty Program Not Enabled', 'برنامج الولاء غير مفعّل')}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t(
              'This store does not currently offer a loyalty rewards program.',
              'المتجر ده مش بيقدم برنامج مكافآت ولاء دلوقتي.'
            )}
          </p>
        </div>
      </div>
    );
  }

  // Customer is authenticated and loyalty is active for this store, but they
  // have no loyalty record yet — show the enrolment CTA.
  if (notEnrolled && !isLoadingPoints) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t('Loyalty Program', 'برنامج الولاء')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t(
              'Earn points on every purchase and redeem them at checkout',
              'اكسب نقط على كل شراء واستبدلها وقت الدفع'
            )}
          </p>
        </div>

        {/* Join CTA card */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-8 text-center">
            {/* Star / reward icon */}
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <svg
                className="h-8 w-8 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                />
              </svg>
            </div>

            <h2 className="mt-5 text-2xl font-bold text-foreground">
              {t('Join Our Loyalty Program', 'انضم إلى برنامج الولاء')}
            </h2>
            <p className="mt-2 text-muted-foreground max-w-sm mx-auto">
              {t(
                'Sign up today and start earning points on every order. Redeem your points for discounts at checkout.',
                'سجّل النهارده وابدأ اكسب نقط على كل طلب. استبدل نقطك بخصومات وقت الدفع.'
              )}
            </p>

            {/* Benefits list */}
            <ul className="mt-6 space-y-2 text-sm text-start max-w-xs mx-auto">
              <li className="flex items-center gap-2 text-foreground">
                <svg
                  className="h-4 w-4 flex-shrink-0 text-success-ink"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t('Earn points on every purchase', 'اكسب نقط على كل شراء')}
              </li>
              <li className="flex items-center gap-2 text-foreground">
                <svg
                  className="h-4 w-4 flex-shrink-0 text-success-ink"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t('Redeem points for discounts at checkout', 'استبدل النقط بخصومات وقت الدفع')}
              </li>
              <li className="flex items-center gap-2 text-foreground">
                <svg
                  className="h-4 w-4 flex-shrink-0 text-success-ink"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t('Unlock higher tiers with more rewards', 'اطلع مستويات أعلى وخد مكافآت أكتر')}
              </li>
            </ul>

            <button
              onClick={handleJoin}
              disabled={isJoining}
              className="mt-8 inline-flex items-center gap-2 rounded-lg bg-primary px-8 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isJoining ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                  {t('Joining…', 'بنسجّلك…')}
                </>
              ) : (
                t('Join Now', 'انضم الآن')
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {t('Loyalty Program', 'برنامج الولاء')}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t('Your points and rewards', 'نقطك ومكافآتك')}
        </p>
      </div>

      {/* Points summary card */}
      {isLoadingPoints ? (
        <div className="flex justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : pointsError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive-ink">
          {pointsError}
        </div>
      ) : loyaltyPoints ? (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-primary/10 to-primary/5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  {t('Current Balance', 'الرصيد الحالي')}
                </p>
                <p className="mt-1 text-5xl font-bold text-primary">
                  {localize(loyaltyPoints.points.toLocaleString('en-US'))}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{t('points', 'نقط')}</p>
              </div>
              {loyaltyPoints.tier && (
                <div className="text-right">
                  <p className="text-sm text-muted-foreground mb-1">
                    {t('Membership Tier', 'مستوى العضوية')}
                  </p>
                  <span
                    className={`inline-block rounded-full px-4 py-1 text-sm font-semibold ${tierColor(
                      loyaltyPoints.tier
                    )}`}
                  >
                    {loyaltyPoints.tier.charAt(0).toUpperCase() + loyaltyPoints.tier.slice(1)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Transaction history */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-foreground">{t('Points History', 'سجل النقط')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('Your recent loyalty activity', 'نشاط الولاء الأخير')}
          </p>
        </div>

        {isLoadingHistory ? (
          <div className="flex justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : historyError ? (
          <div className="p-6">
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive-ink">
              {historyError}
            </div>
          </div>
        ) : transactions.length === 0 ? (
          <div className="p-10 text-center">
            <svg
              className="mx-auto h-10 w-10 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p className="mt-3 text-muted-foreground">
              {t('No transactions yet.', 'مفيش معاملات لسه.')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted text-left">
                  <th className="px-6 py-3 font-medium text-muted-foreground">
                    {t('Date', 'التاريخ')}
                  </th>
                  <th className="px-6 py-3 font-medium text-muted-foreground">
                    {t('Type', 'النوع')}
                  </th>
                  <th className="px-6 py-3 font-medium text-muted-foreground">
                    {t('Description', 'الوصف')}
                  </th>
                  <th className="px-6 py-3 text-right font-medium text-muted-foreground">
                    {t('Points', 'النقط')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {transactions.map(txn => {
                  const isPositive = txn.points >= 0;
                  return (
                    <tr key={txn.id} className="hover:bg-muted">
                      <td className="whitespace-nowrap px-6 py-4 text-muted-foreground">
                        {formatDate(txn.createdAt)}
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-block rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground capitalize">
                          {txn.type?.replace(/_/g, ' ') ?? 'transaction'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-foreground">{txn.description || '-'}</td>
                      <td
                        className={`px-6 py-4 text-right font-semibold ${
                          isPositive ? 'text-success-ink' : 'text-destructive-ink'
                        }`}
                      >
                        <SignedNumber value={txn.points} plus />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
