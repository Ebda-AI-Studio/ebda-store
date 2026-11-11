'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EtaConnectionInput } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPut } from '@/lib/api';

import { Button } from '@/components/ui/Button';
interface Connection {
  connected: boolean;
  enabled: boolean;
  environment: 'preprod' | 'prod';
  clientId: string | null;
  clientSecret: string | null;
  posSerial: string | null;
  posPreSharedKey: string | null;
  branchCode: string | null;
  activityCode: string | null;
  defaultItemCode: string | null;
  address: EtaConnectionInput['address'] | null;
  signingBridgeUrl: string | null;
  lastCheckStatus: string | null;
  lastCheckedAt: string | null;
}

const EMPTY_ADDR = {
  governate: '',
  regionCity: '',
  street: '',
  buildingNumber: '',
  postalCode: '',
};

/**
 * Egypt ETA e-receipt connection (Ruling ETA-1). Rendered only while the store has the `eta_ereceipt`
 * feature. Secrets are write-only: the server returns `****abcd`; sending that back keeps the stored value.
 */
export function EtaConnectionCard({ storeId }: { storeId: string }) {
  const t = useT('eta');
  const base = `/api/v1/stores/${storeId}/eta/connection`;
  const [conn, setConn] = useState<Connection | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'check'>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [f, setF] = useState({
    enabled: false,
    environment: 'preprod' as 'preprod' | 'prod',
    clientId: '',
    clientSecret: '',
    posSerial: '',
    posPreSharedKey: '',
    branchCode: '',
    activityCode: '',
    defaultItemCode: '',
    address: EMPTY_ADDR,
    signingBridgeUrl: '',
    signingBridgeToken: '',
  });

  const apply = useCallback((c: Connection) => {
    setConn(c);
    setF(p => ({
      ...p,
      enabled: c.enabled,
      environment: c.environment,
      clientId: c.clientId ?? '',
      clientSecret: c.clientSecret ?? '',
      posSerial: c.posSerial ?? '',
      posPreSharedKey: c.posPreSharedKey ?? '',
      branchCode: c.branchCode ?? '',
      activityCode: c.activityCode ?? '',
      defaultItemCode: c.defaultItemCode ?? '',
      address: { ...EMPTY_ADDR, ...(c.address ?? {}) },
      signingBridgeUrl: c.signingBridgeUrl ?? '',
      signingBridgeToken: '',
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ connection: Connection }>(base).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data?.connection) setLoadError(true);
      else apply(data.connection);
    });
    return () => {
      cancelled = true;
    };
  }, [base, apply]);

  if (loadError)
    return (
      <div id="eta-ereceipts" className="rounded-xl border border-border bg-card p-4 mb-4">
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadFailed')}
        </p>
      </div>
    );
  if (!conn)
    return (
      <div id="eta-ereceipts" className="rounded-xl border border-border bg-card p-4 mb-4">
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </div>
    );

  const set = (patch: Partial<typeof f>) => setF(p => ({ ...p, ...patch }));
  const setAddr = (patch: Partial<typeof EMPTY_ADDR>) =>
    setF(p => ({ ...p, address: { ...p.address, ...patch } }));

  const save = async () => {
    setMsg(null);
    setBusy('save');
    const body = {
      enabled: f.enabled,
      environment: f.environment,
      clientId: f.clientId.trim(),
      // clear-gate-allow: write-only secret, omitted = keep the stored encrypted value (the server never returns it)
      clientSecret: f.clientSecret.trim() || undefined,
      posSerial: f.posSerial.trim(),
      // clear-gate-allow: write-only secret, omitted = keep the stored encrypted value (the server never returns it)
      posPreSharedKey: f.posPreSharedKey.trim() || undefined,
      branchCode: f.branchCode.trim(),
      activityCode: f.activityCode.trim(),
      defaultItemCode: f.defaultItemCode.trim(),
      address: {
        governate: f.address.governate.trim(),
        regionCity: f.address.regionCity.trim(),
        street: f.address.street.trim(),
        buildingNumber: f.address.buildingNumber.trim(),
        ...(f.address.postalCode.trim() ? { postalCode: f.address.postalCode.trim() } : {}),
      },
      signingBridgeUrl: f.signingBridgeUrl.trim() || null,
      // clear-gate-allow: write-only secret, omitted = keep the stored encrypted value (the server never returns it)
      signingBridgeToken: f.signingBridgeToken.trim() || undefined,
    };
    const { data, error } = await apiPut<{ connection: Connection }>(base, body);
    setBusy(null);
    if (error || !data?.connection)
      setMsg({ tone: 'error', text: error?.message || t('saveFailed') });
    else {
      apply(data.connection);
      setMsg({ tone: 'ok', text: t('saved') });
    }
  };

  const check = async () => {
    setMsg(null);
    setBusy('check');
    const { data, error } = await apiPost<{ ok: boolean; status: string }>(`${base}/check`, {});
    setBusy(null);
    if (error || !data) return setMsg({ tone: 'error', text: error?.message || t('checkFailed') });
    setMsg(
      data.ok
        ? { tone: 'ok', text: t('checkOk') }
        : { tone: 'error', text: t('checkRefused', { code: data.status }) }
    );
    void apiGet<{ connection: Connection }>(base).then(
      r => r.data?.connection && apply(r.data.connection)
    );
  };

  const input = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
  const label = 'block text-sm font-medium text-foreground mb-1';
  const field = (
    id: string,
    text: string,
    value: string,
    onChange: (v: string) => void,
    opts?: { secret?: boolean; hint?: string }
  ) => (
    <div>
      <label htmlFor={`eta-${id}`} className={label}>
        {text}
      </label>
      <input
        id={`eta-${id}`}
        className={input}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        {...(opts?.secret ? { type: 'password' } : {})}
      />
      {opts?.hint ? <p className="mt-1 text-xs text-muted-foreground">{opts.hint}</p> : null}
    </div>
  );

  return (
    <section
      id="eta-ereceipts"
      className="rounded-xl border border-border bg-card p-4 mb-4"
      aria-labelledby="eta-title"
    >
      <h2
        id="eta-title"
        data-setting-id="tax.eta"
        className="text-base font-semibold text-foreground"
      >
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="eta-env" className={label}>
            {t('environment')}
          </label>
          <select
            id="eta-env"
            className={input}
            value={f.environment}
            onChange={e => set({ environment: e.target.value as 'preprod' | 'prod' })}
          >
            <option value="preprod">{t('envPreprod')}</option>
            <option value="prod">{t('envProd')}</option>
          </select>
        </div>
        <label className="flex items-center gap-2 pt-6 text-sm">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={e => set({ enabled: e.target.checked })}
          />
          {t('enabled')}
        </label>
        {field('client-id', t('clientId'), f.clientId, v => set({ clientId: v }))}
        {field('client-secret', t('clientSecret'), f.clientSecret, v => set({ clientSecret: v }), {
          secret: true,
          hint: t('secretHint'),
        })}
        {field('pos-serial', t('posSerial'), f.posSerial, v => set({ posSerial: v }))}
        {field('psk', t('preSharedKey'), f.posPreSharedKey, v => set({ posPreSharedKey: v }), {
          secret: true,
        })}
        {field('branch', t('branchCode'), f.branchCode, v => set({ branchCode: v }))}
        {field('activity', t('activityCode'), f.activityCode, v => set({ activityCode: v }))}
        {field('item-code', t('itemCode'), f.defaultItemCode, v => set({ defaultItemCode: v }), {
          hint: t('itemCodeHint'),
        })}
      </div>

      <h3 className="mt-5 text-sm font-semibold text-foreground">{t('addressTitle')}</h3>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {field('gov', t('governate'), f.address.governate, v => setAddr({ governate: v }))}
        {field('city', t('regionCity'), f.address.regionCity, v => setAddr({ regionCity: v }))}
        {field('street', t('street'), f.address.street, v => setAddr({ street: v }))}
        {field('building', t('buildingNumber'), f.address.buildingNumber, v =>
          setAddr({ buildingNumber: v })
        )}
        {field('postal', t('postalCode'), f.address.postalCode, v => setAddr({ postalCode: v }))}
      </div>

      <details className="mt-5">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          {t('bridgeTitle')}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">{t('bridgeHint')}</p>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          {field('bridge-url', t('bridgeUrl'), f.signingBridgeUrl, v =>
            set({ signingBridgeUrl: v })
          )}
          {field(
            'bridge-token',
            t('bridgeToken'),
            f.signingBridgeToken,
            v => set({ signingBridgeToken: v }),
            { secret: true }
          )}
        </div>
      </details>

      {conn.lastCheckedAt ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {conn.lastCheckStatus === 'ok'
            ? t('lastCheckOk')
            : t('lastCheckRefused', { code: conn.lastCheckStatus ?? '' })}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={busy !== null} variant="default">
          {busy === 'save' ? t('saving') : t('save')}
        </Button>
        <Button
          type="button"
          onClick={check}
          disabled={busy !== null || !conn.connected}
          variant="outline"
        >
          {busy === 'check' ? t('checking') : t('check')}
        </Button>
        {msg ? (
          <p
            role={msg.tone === 'error' ? 'alert' : 'status'}
            className={`text-sm ${msg.tone === 'error' ? 'text-destructive-ink' : 'text-success-ink'}`}
          >
            {msg.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
