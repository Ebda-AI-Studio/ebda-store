'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import {
  ProviderCard,
  type ProviderDef,
  type ProviderSaveMessage,
  type StorePaymentConfig,
} from './_components/ProviderCard';

const PROVIDERS: ProviderDef[] = [
  { id: 'tap', name: 'Tap Payments', nameAr: 'تاب للمدفوعات', color: '#00D4AA', kind: 'gateway' },
  { id: 'myfatoorah', name: 'MyFatoorah', nameAr: 'ماي فاتورة', color: '#00A651', kind: 'gateway' },
  { id: 'hesabe', name: 'Hesabe', nameAr: 'حسابي', color: '#E31837', kind: 'gateway' },
  { id: 'upayments', name: 'UPayments', nameAr: 'يو بيمنتس', color: '#1E88E5', kind: 'gateway' },
  {
    id: 'cod',
    name: 'Cash on Delivery',
    nameAr: 'الدفع عند الاستلام',
    color: '#64748B',
    kind: 'cod',
  },
];

const emptyConfig = (provider: string): StorePaymentConfig => ({
  provider,
  isEnabled: false,
  apiKey: '',
  secretKey: '',
  webhookSecret: '',
  merchantId: '',
  testMode: provider === 'cod' ? false : true,
  displayName: provider === 'cod' ? 'Cash on Delivery' : '',
  displayNameAr: provider === 'cod' ? 'الدفع عند الاستلام' : '',
  fixedFee: 0,
});

export default function StorePaymentSettingsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('paymentSettings');

  const [configs, setConfigs] = useState<StorePaymentConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [forms, setForms] = useState<Record<string, StorePaymentConfig>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveMessages, setSaveMessages] = useState<Record<string, ProviderSaveMessage>>({});

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fetchConfigs = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<
        | { storeConfigs?: StorePaymentConfig[]; configs?: StorePaymentConfig[] }
        | StorePaymentConfig[]
      >(`/api/v1/payment-settings/store/${storeId}`);

      if (apiError) {
        setError(apiError.message || t('errors.loadFailed'));
        return;
      }

      const loaded: StorePaymentConfig[] = Array.isArray(data)
        ? data
        : (data as { storeConfigs?: StorePaymentConfig[]; configs?: StorePaymentConfig[] })
            ?.storeConfigs ||
          (data as { storeConfigs?: StorePaymentConfig[]; configs?: StorePaymentConfig[] })
            ?.configs ||
          [];
      setConfigs(loaded);

      const initialForms: Record<string, StorePaymentConfig> = {};
      PROVIDERS.forEach(p => {
        const existing = loaded.find(c => c.provider === p.id);
        initialForms[p.id] = existing ? { ...existing } : emptyConfig(p.id);
      });
      setForms(initialForms);
    } catch {
      setError(t('errors.connectionError'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  function updateForm(
    provider: string,
    field: keyof StorePaymentConfig,
    value: string | number | boolean | null
  ) {
    setForms(prev => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
    if (saveMessages[provider]) {
      setSaveMessages(prev => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
    }
  }

  async function handleToggle(provider: string, enabled: boolean) {
    setForms(prev => ({
      ...prev,
      [provider]: { ...prev[provider], isEnabled: enabled },
    }));
    await handleSave(provider, { isEnabled: enabled });
  }

  async function handleSave(provider: string, overrides?: Partial<StorePaymentConfig>) {
    setSaving(provider);
    setSaveMessages(prev => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });

    const formData = { ...forms[provider], ...overrides };
    const existingConfig = configs.find(c => c.provider === provider);
    const isNew = !existingConfig?.id;

    const isCod = provider === 'cod';

    try {
      const body: Record<string, unknown> = isCod
        ? {
            provider,
            isEnabled: formData.isEnabled,
            displayName: formData.displayName || 'Cash on Delivery',
            displayNameAr: formData.displayNameAr || 'الدفع عند الاستلام',
            fixedFee: Math.max(0, Math.floor(Number(formData.fixedFee) || 0)),
            testMode: false,
          }
        : {
            provider: formData.provider,
            isEnabled: formData.isEnabled,
            testMode: formData.testMode,
            ...(formData.apiKey ? { apiKey: formData.apiKey } : {}),
            ...(formData.secretKey ? { secretKey: formData.secretKey } : {}),
            ...(formData.webhookSecret ? { webhookSecret: formData.webhookSecret } : {}),
            ...(formData.merchantId ? { merchantId: formData.merchantId } : {}),
          };

      const endpoint = isNew
        ? `/api/v1/payment-settings/store/${storeId}`
        : `/api/v1/payment-settings/store/${storeId}/${provider}`;

      const apiCall = isNew ? apiPost : apiPut;
      const { error: saveError } = await apiCall(endpoint, body);

      if (!saveError) {
        setSaveMessages(prev => ({
          ...prev,
          [provider]: { type: 'success', text: t('messages.savedSuccess') },
        }));
        await fetchConfigs();
      } else {
        setSaveMessages(prev => ({
          ...prev,
          [provider]: {
            type: 'error',
            text: saveError.message || t('messages.failedToSave'),
          },
        }));
        if (overrides?.isEnabled !== undefined) {
          setForms(prev => ({
            ...prev,
            [provider]: { ...prev[provider], isEnabled: !overrides.isEnabled },
          }));
        }
      }
    } catch {
      setSaveMessages(prev => ({
        ...prev,
        [provider]: { type: 'error', text: t('messages.unableToConnect') },
      }));
    } finally {
      setSaving(null);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      actions={
        <Link href={`/stores/${storeId}/settings`}>
          <Button type="button" variant="outline">
            {t('actions.backToSettings')}
          </Button>
        </Link>
      }
    >
      {error && (
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchConfigs}>
            {t('errors.retry')}
          </button>
        </div>
      )}

      <div className="space-y-4">
        {PROVIDERS.map(provider => {
          const form = forms[provider.id] ?? emptyConfig(provider.id);
          const isExpanded = expanded[provider.id] ?? false;
          const isSavingThis = saving === provider.id;
          const message = saveMessages[provider.id];

          return (
            <ProviderCard
              key={provider.id}
              provider={provider}
              form={form}
              expanded={isExpanded}
              saving={isSavingThis}
              message={message}
              onToggle={enabled => handleToggle(provider.id, enabled)}
              onToggleExpanded={() =>
                setExpanded(prev => ({ ...prev, [provider.id]: !isExpanded }))
              }
              onUpdateField={(field, value) => updateForm(provider.id, field, value)}
              onSave={() => handleSave(provider.id)}
            />
          );
        })}
      </div>
    </AdminLayout>
  );
}
