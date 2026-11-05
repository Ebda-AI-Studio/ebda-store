'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { apiGet, apiDelete } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { ConfirmActionModal } from '../../../components/ConfirmActionModal';
import { EnableOrderAlertsButton } from '../../../components/EnableOrderAlertsButton';

interface OneSignalDevice {
  id: string;
  playerId: string;
  deviceLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function DevicesPage() {
  const tc = useT('common');
  const t = useT('orders.devices');
  const locale = useLocale();
  const { error: toastError } = useToast();

  const [devices, setDevices] = useState<OneSignalDevice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await apiGet<{ devices: OneSignalDevice[] }>(
        '/api/v1/admin/notifications/onesignal/devices'
      );
      if (error) {
        toastError(t('error'));
      } else {
        setDevices(data?.devices ?? []);
      }
    } finally {
      setIsLoading(false);
    }
  }, [t, toastError]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleRemove = async () => {
    if (!confirmRemoveId) return;
    try {
      const { error } = await apiDelete(
        `/api/v1/admin/notifications/onesignal/devices/${confirmRemoveId}`
      );
      if (error) {
        toastError(t('removeError'));
      } else {
        setDevices(d => d.filter(x => x.playerId !== confirmRemoveId));
      }
    } finally {
      setConfirmRemoveId(null);
    }
  };

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="mb-4">
          <EnableOrderAlertsButton onDone={() => void fetchDevices()} />
        </div>
        {isLoading && (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t('loading')}
          </div>
        )}

        {!isLoading && devices.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </div>
        )}

        {!isLoading && devices.length > 0 && (
          <ul className="space-y-3">
            {devices.map(d => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                      />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">
                      {d.deviceLabel || t('browserFallback')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('registered', {
                        date: new Date(d.createdAt).toLocaleDateString(locale, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          numberingSystem: 'latn', // Latin digits in both locales (issue 1971)
                        }),
                      })}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmRemoveId(d.playerId)}
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-sm font-medium text-destructive-ink hover:bg-destructive/10 transition-colors cursor-pointer"
                >
                  {t('remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmActionModal
        open={!!confirmRemoveId}
        title={t('removeConfirmTitle')}
        description={t('removeConfirmDescription')}
        confirmLabel={t('remove')}
        cancelLabel={tc('cancel')}
        onConfirm={handleRemove}
        onClose={() => setConfirmRemoveId(null)}
      />
    </AdminLayout>
  );
}
