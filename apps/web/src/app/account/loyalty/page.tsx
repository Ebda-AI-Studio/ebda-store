'use client';

import { useState, useEffect } from 'react';
import { useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

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

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Fetch wrapper that attaches the stored auth token. */
async function authFetch(url: string) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  return fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export default function LoyaltyPage() {
  const { store } = useStore();
  const { t } = useLanguage();
  const storeId = store.id;

  const [loyaltyPoints, setLoyaltyPoints] = useState<LoyaltyPoints | null>(null);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [isLoadingPoints, setIsLoadingPoints] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loyaltyDisabled, setLoyaltyDisabled] = useState(false);

  useEffect(() => {
    // Guard: do not attempt to fetch until we have a real store id
    if (!storeId || storeId === 'demo') return;

    async function fetchPoints() {
      setIsLoadingPoints(true);
      setPointsError(null);
      try {
        const res = await authFetch(`${API_URL}/stores/${storeId}/loyalty/points`);
        const json = await res.json();

        if (res.status === 404 || json?.error?.code === 'LOYALTY_DISABLED') {
          setLoyaltyDisabled(true);
          return;
        }

        if (res.ok && json.success) {
          setLoyaltyPoints(json.data ?? json);
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
        const res = await authFetch(`${API_URL}/stores/${storeId}/loyalty/transactions`);
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
  }, [storeId]);

  // Derive tier badge color
  function tierColor(tier?: string) {
    switch (tier?.toLowerCase()) {
      case 'gold':
        return 'bg-yellow-100 text-yellow-800';
      case 'silver':
        return 'bg-gray-100 text-gray-700';
      case 'platinum':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-blue-100 text-blue-800';
    }
  }

  if (!storeId || storeId === 'demo') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Loyalty Program</h1>
          <p className="mt-1 text-gray-500">Your points and rewards</p>
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
          <h1 className="text-2xl font-bold text-gray-900">Loyalty Program</h1>
          <p className="mt-1 text-gray-500">Your points and rewards</p>
        </div>
        <div className="rounded-xl border bg-white p-10 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
            <svg
              className="h-7 w-7 text-gray-400"
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
          <h2 className="mt-4 text-lg font-semibold text-gray-900">
            {t('Loyalty Program Not Enabled', 'برنامج الولاء غير مفعّل')}
          </h2>
          <p className="mt-2 text-gray-500">
            {t(
              'This store does not currently offer a loyalty rewards program.',
              'هذا المتجر لا يقدم حالياً برنامج مكافآت ولاء.'
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {t('Loyalty Program', 'برنامج الولاء')}
        </h1>
        <p className="mt-1 text-gray-500">{t('Your points and rewards', 'نقاطك ومكافآتك')}</p>
      </div>

      {/* Points summary card */}
      {isLoadingPoints ? (
        <div className="flex justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : pointsError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {pointsError}
        </div>
      ) : loyaltyPoints ? (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-primary/10 to-primary/5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-gray-500">
                  {t('Current Balance', 'الرصيد الحالي')}
                </p>
                <p className="mt-1 text-5xl font-bold text-primary">
                  {loyaltyPoints.points.toLocaleString()}
                </p>
                <p className="mt-1 text-sm text-gray-500">{t('points', 'نقاط')}</p>
              </div>
              {loyaltyPoints.tier && (
                <div className="text-right">
                  <p className="text-sm text-gray-500 mb-1">
                    {t('Membership Tier', 'مستوى العضوية')}
                  </p>
                  <span
                    className={`inline-block rounded-full px-4 py-1 text-sm font-semibold ${tierColor(loyaltyPoints.tier)}`}
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
      <div className="rounded-xl border bg-white shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-gray-900">{t('Points History', 'سجل النقاط')}</h2>
          <p className="text-sm text-gray-500">
            {t('Your recent loyalty activity', 'نشاط الولاء الأخير')}
          </p>
        </div>

        {isLoadingHistory ? (
          <div className="flex justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : historyError ? (
          <div className="p-6">
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
              {historyError}
            </div>
          </div>
        ) : transactions.length === 0 ? (
          <div className="p-10 text-center">
            <svg
              className="mx-auto h-10 w-10 text-gray-300"
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
            <p className="mt-3 text-gray-500">
              {t('No transactions yet.', 'لا توجد معاملات بعد.')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left">
                  <th className="px-6 py-3 font-medium text-gray-500">{t('Date', 'التاريخ')}</th>
                  <th className="px-6 py-3 font-medium text-gray-500">{t('Type', 'النوع')}</th>
                  <th className="px-6 py-3 font-medium text-gray-500">
                    {t('Description', 'الوصف')}
                  </th>
                  <th className="px-6 py-3 text-right font-medium text-gray-500">
                    {t('Points', 'النقاط')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {transactions.map(txn => {
                  const isPositive = txn.points >= 0;
                  return (
                    <tr key={txn.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-6 py-4 text-gray-500">
                        {formatDate(txn.createdAt)}
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-block rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 capitalize">
                          {txn.type?.replace(/_/g, ' ') ?? 'transaction'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-gray-700">{txn.description || '-'}</td>
                      <td
                        className={`px-6 py-4 text-right font-semibold ${
                          isPositive ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {isPositive ? '+' : ''}
                        {txn.points.toLocaleString()}
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
