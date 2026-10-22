'use client';

import { useT } from '@/i18n/useT';
import type { PlatformStats } from './types';

/** Super-admin: signups that came through the "made with Ebda" store badge and the first-order referral email. */
export function ReferralCard({ referrals }: { referrals: PlatformStats['referrals'] }) {
  const t = useT('dashboard.super');
  if (!referrals) return null;
  return (
    <section className="force-card mt-8 p-4" aria-labelledby="referral-h">
      <h2 id="referral-h" className="text-sm font-semibold">
        {t('referralsTitle')}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('referralsNote')}</p>
      <dl className="mt-3 flex gap-8 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('referralsBadge')}</dt>
          <dd className="text-xl font-semibold">{referrals.badge}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('referralsEmail')}</dt>
          <dd className="text-xl font-semibold">{referrals.email}</dd>
        </div>
      </dl>
    </section>
  );
}
