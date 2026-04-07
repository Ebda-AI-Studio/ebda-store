'use client';

import { useState, useEffect } from 'react';
import { useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { API_URL } from '../../../lib/api';

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

/** Fetch wrapper that sends auth cookies. */
async function authFetch(url: string) {
  return fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
}

export default function LoyaltyClient() {
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
        return 'bg-[hsl(var(--warning))]/20 text-[hsl(var(--warning))]';
      case 'silver':
        return 'bg-muted text-foreground';
      case 'platinum':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-[hsl(var(--info))]/20 text-[hsl(var(--info))]';
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
            {t('Your points and rewards', 'نقاطك ومكافآتك')}
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
            {t('Your points and rewards', 'نقاطك ومكافآتك')}
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
            {t(
              'Loyalty Program Not Enabled',
              '\u0628\u0631\u0646\u0627\u0645\u062c \u0627\u0644\u0648\u0644\u0627\u0621 \u063a\u064a\u0631 \u0645\u0641\u0639\u0651\u0644'
            )}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t(
              'This store does not currently offer a loyalty rewards program.',
              '\u0647\u0630\u0627 \u0627\u0644\u0645\u062a\u062c\u0631 \u0644\u0627 \u064a\u0642\u062f\u0645 \u062d\u0627\u0644\u064a\u0627\u064b \u0628\u0631\u0646\u0627\u0645\u062c \u0645\u0643\u0627\u0641\u0622\u062a \u0648\u0644\u0627\u0621.'
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {t(
            'Loyalty Program',
            '\u0628\u0631\u0646\u0627\u0645\u062c \u0627\u0644\u0648\u0644\u0627\u0621'
          )}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t(
            'Your points and rewards',
            '\u0646\u0642\u0627\u0637\u0643 \u0648\u0645\u0643\u0627\u0641\u0622\u062a\u0643'
          )}
        </p>
      </div>

      {/* Points summary card */}
      {isLoadingPoints ? (
        <div className="flex justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : pointsError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive">
          {pointsError}
        </div>
      ) : loyaltyPoints ? (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-primary/10 to-primary/5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  {t(
                    'Current Balance',
                    '\u0627\u0644\u0631\u0635\u064a\u062f \u0627\u0644\u062d\u0627\u0644\u064a'
                  )}
                </p>
                <p className="mt-1 text-5xl font-bold text-primary">
                  {loyaltyPoints.points.toLocaleString()}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('points', '\u0646\u0642\u0627\u0637')}
                </p>
              </div>
              {loyaltyPoints.tier && (
                <div className="text-right">
                  <p className="text-sm text-muted-foreground mb-1">
                    {t(
                      'Membership Tier',
                      '\u0645\u0633\u062a\u0648\u0649 \u0627\u0644\u0639\u0636\u0648\u064a\u0629'
                    )}
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
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-foreground">
            {t('Points History', '\u0633\u062c\u0644 \u0627\u0644\u0646\u0642\u0627\u0637')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'Your recent loyalty activity',
              '\u0646\u0634\u0627\u0637 \u0627\u0644\u0648\u0644\u0627\u0621 \u0627\u0644\u0623\u062e\u064a\u0631'
            )}
          </p>
        </div>

        {isLoadingHistory ? (
          <div className="flex justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : historyError ? (
          <div className="p-6">
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive">
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
              {t(
                'No transactions yet.',
                '\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0639\u0627\u0645\u0644\u0627\u062a \u0628\u0639\u062f.'
              )}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted text-left">
                  <th className="px-6 py-3 font-medium text-muted-foreground">
                    {t('Date', '\u0627\u0644\u062a\u0627\u0631\u064a\u062e')}
                  </th>
                  <th className="px-6 py-3 font-medium text-muted-foreground">
                    {t('Type', '\u0627\u0644\u0646\u0648\u0639')}
                  </th>
                  <th className="px-6 py-3 font-medium text-muted-foreground">
                    {t('Description', '\u0627\u0644\u0648\u0635\u0641')}
                  </th>
                  <th className="px-6 py-3 text-right font-medium text-muted-foreground">
                    {t('Points', '\u0627\u0644\u0646\u0642\u0627\u0637')}
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
                          isPositive ? 'text-[hsl(var(--success))]' : 'text-destructive'
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
