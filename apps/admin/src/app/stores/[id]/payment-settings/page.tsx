'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { useLocale } from 'next-intl';
import { BRAND, PROVIDER_CATALOG, providerRequestMailto } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import {
  ProviderCard,
  type ProviderDef,
  type ProviderSaveMessage,
  type StorePaymentConfig,
} from './_components/ProviderCard';
import { GatewayConnectCard, type GatewayConfig } from './_components/GatewayConnectCard';
import { InstalmentsCard } from './_components/InstalmentsCard';
import { ActiveMethodsStrip, type ActiveMethodRow } from './_components/ActiveMethodsStrip';

// Gateways (Paymob, Kashier, Fawry...) are schema-driven from the catalog; only the manual
// methods (COD, InstaPay) keep the hand-built card.
const GATEWAYS = PROVIDER_CATALOG.filter(p => p.kind === 'payments' && !p.manual);
const PROVIDERS: ProviderDef[] = PROVIDER_CATALOG.filter(
  p => p.kind === 'payments' && p.manual && (p.code === 'cod' || p.code === 'instapay')
).map(p => ({
  id: p.code,
  name: p.name.en,
  nameAr: p.name.ar,
  color: p.logo.color,
  kind: p.code as ProviderDef['kind'],
}));

type AnyConfig = StorePaymentConfig & GatewayConfig;

const emptyConfig = (provider: string): StorePaymentConfig => ({
  provider,
  isEnabled: false,
  testMode: false,
  displayName: provider === 'cod' ? 'Cash on Delivery' : 'InstaPay',
  displayNameAr: provider === 'cod' ? 'الدفع عند الاستلام' : 'إنستاباي',
  fixedFee: 0,
  settings: {},
});

export default function StorePaymentSettingsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('paymentSettings');
  const isAr = useLocale() === 'ar';

  const [configs, setConfigs] = useState<AnyConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [forms, setForms] = useState<Record<string, StorePaymentConfig>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveMessages, setSaveMessages] = useState<Record<string, ProviderSaveMessage>>({});

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [gatewayBusy, setGatewayBusy] = useState<string | null>(null);

  const fetchConfigs = useCallback(async () => {
    if (!storeId) return;
    // No skeleton on refetch: it would unmount the cards (and their notices) after every save.
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<
        { storeConfigs?: AnyConfig[]; configs?: AnyConfig[] } | AnyConfig[]
      >(`/api/v1/payment-settings/store/${storeId}`);

      if (apiError) {
        setError(apiError.message || t('errors.loadFailed'));
        return;
      }

      const loaded: AnyConfig[] = Array.isArray(data)
        ? data
        : (data as { storeConfigs?: AnyConfig[]; configs?: AnyConfig[] })?.storeConfigs ||
          (data as { storeConfigs?: AnyConfig[]; configs?: AnyConfig[] })?.configs ||
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
    value: string | number | boolean | null | Record<string, unknown>
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
            settings: { percentBps: Number(formData.settings?.percentBps) || 0 },
          }
        : {
            provider,
            isEnabled: formData.isEnabled,
            displayName: formData.displayName || 'InstaPay',
            displayNameAr: formData.displayNameAr || 'إنستاباي',
            testMode: false,
            settings: Object.fromEntries(
              Object.entries(formData.settings ?? {}).filter(
                ([, v]) => v !== '' && v !== null && v !== undefined
              )
            ),
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

  // A gateway can be turned off from the strip any time; turning it ON needs a saved, tested connection.
  async function toggleGateway(code: string, enabled: boolean) {
    setGatewayBusy(code);
    const { error: toggleError } = await apiPost(
      `/api/v1/payment-settings/store/${storeId}/${code}/toggle`,
      { enabled }
    );
    setGatewayBusy(null);
    if (toggleError) setError(toggleError.message || t('errors.loadFailed'));
    await fetchConfigs();
  }

  const stripRows: ActiveMethodRow[] = [
    ...PROVIDERS.map(p => ({
      id: p.id,
      name: isAr ? p.nameAr : p.name,
      enabled: forms[p.id]?.isEnabled ?? false,
      busy: saving === p.id,
      onToggle: (on: boolean) => handleToggle(p.id, on),
    })),
    ...GATEWAYS.flatMap(g => {
      const c = configs.find(x => x.provider === g.code);
      const connected = Boolean(c?.connectionTestCurrent && c?.connectionTest?.ok);
      if (!c?.isEnabled && !connected) return [];
      return [
        {
          id: g.code,
          name: isAr ? g.name.ar : g.name.en,
          enabled: Boolean(c?.isEnabled),
          busy: gatewayBusy === g.code,
          onToggle: (on: boolean) => toggleGateway(g.code, on),
        },
      ];
    }),
  ];

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
    <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
      {error && (
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink">
          {error}
          <Button type="button" variant="outline" className="ms-4" onClick={fetchConfigs}>
            {t('errors.retry')}
          </Button>
        </div>
      )}

      <div className="mb-6 rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t('page.intro')}</p>
        <p className="mt-1.5 text-xs">{t('page.testModeNote')}</p>
      </div>

      <ActiveMethodsStrip rows={stripRows} />

      <h2 className="mb-1 text-base font-semibold text-foreground">{t('strip.addTitle')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('strip.addHint')}</p>
      <div className="space-y-4">
        {GATEWAYS.map(entry => (
          <GatewayConnectCard
            key={entry.code}
            entry={entry}
            config={configs.find(c => c.provider === entry.code)}
            storeId={storeId}
            onChanged={async () => {
              await fetchConfigs();
            }}
          />
        ))}
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

      <div className="mt-6">
        <InstalmentsCard storeId={storeId} />
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        <a
          href={providerRequestMailto(BRAND.supportEmail, 'payments')}
          className="text-primary underline"
        >
          {t('connect.requestProvider')}
        </a>
      </p>
    </AdminLayout>
  );
}
