'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button, Modal, useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { apiDelete, apiGet, apiPost, apiPut, getApiUrl } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { withNumerals } from '@ebda/shared';

/**
 * Merchant screen for the MCP merchant-admin keys — issue, review, revoke.
 *
 * ## Why a LIST, where the agent key page is a single credential
 *
 * `/stores/[id]/agent-key` manages ONE value, because the buyer credential has
 * one holder: the shopping-agent integration. A merchant-admin key is a DEVICE
 * credential — one per laptop, per CI job, per teammate — so this screen is a
 * table with per-row revoke. Revoking the key on a lost laptop must not sign
 * out the merchant's other machines, and each row names the person it acts as,
 * because every audit row the key produces carries that human.
 *
 * ## Once-only display, and why there is no "show it again"
 *
 * The server stores a SHA-256 HASH, not ciphertext (unlike the agent key,
 * which the admin displays and therefore must encrypt reversibly). Nobody —
 * including us — can read a merchant key back. The plaintext exists in this
 * browser exactly once, in `mintedKey` state, for as long as the reveal modal
 * is open: never in localStorage, never in the URL, never re-fetched. `GET`
 * returns metadata and a display prefix only. A lost key is REVOKED and
 * re-minted, which is why revoke needs no confirmation beyond the modal —
 * unlike rotating a single shared credential, revoking one device does not
 * break the merchant's other integrations.
 *
 * ## Scopes are a real choice, defaulted safe
 *
 * Read / write / destructive are three tiers, and the form defaults to READ
 * ONLY. A merchant issuing a key for a reporting script should not have to
 * think in order to get the safe outcome; someone who wants a key that can
 * delete products has to tick the box that says so.
 */

type Scope = 'merchant:read' | 'merchant:write' | 'merchant:destructive';

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
  user: { id: string; email: string; firstName: string | null; lastName: string | null } | null;
}

interface ListResponse {
  header: string;
  /** Addressed by slug, not id — the MCP endpoint path uses it. */
  storeSlug: string | null;
  availableScopes: Scope[];
  keys: KeyRow[];
}

interface MintResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  expiresAt: string | null;
  apiKey: string;
  header: string;
  warning: string;
}

const SCOPE_ORDER: Scope[] = ['merchant:read', 'merchant:write', 'merchant:destructive'];

export default function MerchantKeysPage() {
  const { gate } = useRequireFeature('merchant_mcp');

  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('merchantKeys');
  const { success: toastSuccess, error: toastError } = useToast();

  const [data, setData] = useState<ListResponse | null>(null);
  const [busy, setBusy] = useState<'mint' | string | null>(null);

  // The one-time reveal. State only — never persisted anywhere.
  const [minted, setMinted] = useState<MintResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['merchant:read']);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<KeyRow | null>(null);

  const endpoint = `/api/v1/stores/${storeId}/integrations/merchant-keys`;
  const switchEndpoint = `/api/v1/stores/${storeId}/integrations/merchant-mcp/write-switch`;

  // Merchant's own on/off for MCP write tools (store.settings.mcpWriteEnabled).
  const [writeEnabled, setWriteEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!storeId) return;
    void apiGet<{ enabled: boolean }>(switchEndpoint).then(({ data: r }) => {
      if (r) setWriteEnabled(r.enabled);
    });
  }, [storeId, switchEndpoint]);
  const toggleWrite = async () => {
    if (writeEnabled === null) return;
    const next = !writeEnabled;
    const { error } = await apiPut<{ enabled: boolean }>(switchEndpoint, { enabled: next });
    if (error) {
      toastError(t('writeSwitch.saveFailed'), error.message);
      return;
    }
    setWriteEnabled(next);
  };

  const load = useCallback(async () => {
    if (!storeId) return;
    const { data: res, error } = await apiGet<ListResponse>(endpoint);
    if (error) {
      toastError(t('toast.loadFailedTitle'), error.message);
      return;
    }
    if (res) setData(res);
  }, [storeId, endpoint, toastError, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCount = useMemo(() => data?.keys.filter(k => k.active).length ?? 0, [data]);

  const resetForm = useCallback(() => {
    setName('');
    setScopes(['merchant:read']);
    setExpiresInDays('');
  }, []);

  const mint = useCallback(async () => {
    setBusy('mint');
    const { data: res, error } = await apiPost<MintResponse>(endpoint, {
      name: name.trim(),
      scopes,
      ...(expiresInDays ? { expiresInDays: Number(expiresInDays) } : {}),
    });
    setBusy(null);
    if (error || !res) {
      toastError(t('toast.mintFailedTitle'), error?.message ?? t('toast.mintFailedBody'));
      return;
    }
    setCreateOpen(false);
    resetForm();
    setCopied(false);
    setMinted(res);
    toastSuccess(t('toast.minted'));
    await load();
  }, [endpoint, name, scopes, expiresInDays, load, resetForm, toastError, toastSuccess, t]);

  const revoke = useCallback(
    async (row: KeyRow) => {
      setBusy(row.id);
      const { error } = await apiDelete(`${endpoint}/${row.id}`);
      setBusy(null);
      setRevokeTarget(null);
      if (error) {
        toastError(t('toast.revokeFailedTitle'), error.message);
        return;
      }
      toastSuccess(t('toast.revoked'));
      await load();
    },
    [endpoint, load, toastError, toastSuccess, t]
  );

  const copyKey = useCallback(async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.apiKey);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (permissions, insecure context). The key is on
      // screen and selectable, so this is a convenience, not the delivery
      // mechanism — never imply the key was lost.
      setCopied(false);
    }
  }, [minted]);

  const dismissReveal = useCallback(() => {
    // The point of the whole feature: after this there is no way back to it.
    setMinted(null);
    setCopied(false);
  }, []);

  const toggleScope = useCallback((scope: Scope) => {
    setScopes(prev => (prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]));
  }, []);

  const fmt = (v: string | null) =>
    v ? new Date(v).toLocaleString(undefined, withNumerals()) : t('table.never');

  const keyColumns: DataTableColumn<KeyRow>[] = [
    {
      header: t('table.name'),
      primaryOnMobile: true,
      cell: row => (
        <span className="text-foreground" dir="auto">
          {row.name}
        </span>
      ),
    },
    {
      header: t('table.key'),
      hideOnMobile: true,
      cell: row => (
        // Forced LTR: a base64url prefix must not be bidi-reordered
        // in an Arabic admin.
        <span className="font-mono text-muted-foreground" dir="ltr">
          {row.prefix}…
        </span>
      ),
    },
    {
      header: t('table.scopes'),
      cell: row => (
        <div className="flex flex-wrap gap-1">
          {row.scopes.map(s => (
            <span
              key={s}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
              dir="ltr"
            >
              {s.replace('merchant:', '')}
            </span>
          ))}
          {row.scopes.length === 0 ? (
            <span className="text-muted-foreground">{t('table.noScopes')}</span>
          ) : null}
        </div>
      ),
    },
    {
      header: t('table.user'),
      cell: row => (
        <span className="text-muted-foreground" dir="auto">
          {row.user?.email ?? '—'}
        </span>
      ),
    },
    {
      header: t('table.lastUsed'),
      hideOnMobile: true,
      cell: row => <span className="text-muted-foreground">{fmt(row.lastUsedAt)}</span>,
    },
    {
      header: t('table.status'),
      mobileBadge: true,
      cell: row => (
        <span
          className={
            row.active
              ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground'
          }
          dir="auto"
        >
          {row.active ? t('table.active') : row.revokedAt ? t('table.revoked') : t('table.expired')}
        </span>
      ),
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      cell: row =>
        row.active ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="max-md:min-h-11 max-md:px-4"
            onClick={() => setRevokeTarget(row)}
            disabled={busy !== null}
          >
            {t('actions.revoke')}
          </Button>
        ) : null,
    },
  ];

  if (gate) return gate;

  return (
    <AdminLayout
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      actions={
        <Button type="button" className="min-h-11" onClick={() => setCreateOpen(true)}>
          {t('actions.mint')}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground" dir="auto">
              {t('writeSwitch.title')}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="auto">
              {t('writeSwitch.body')}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={writeEnabled ? 'default' : 'outline'}
            disabled={writeEnabled === null}
            aria-pressed={writeEnabled === true}
            onClick={() => void toggleWrite()}
          >
            {writeEnabled ? t('writeSwitch.on') : t('writeSwitch.off')}
          </Button>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground" dir="auto">
            {t('intro.heading')}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="auto">
            {t('intro.body')}
          </p>
          {data ? (
            <p className="mt-2 text-xs text-muted-foreground" dir="auto">
              {t('intro.headerLabel')}:{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono" dir="ltr">
                {data.header}
              </code>
              {' · '}
              {t('intro.activeCount', { count: String(activeCount) })}
            </p>
          ) : null}
        </div>

        {data ? (
          <DataTable<KeyRow>
            ariaLabel={t('page.title')}
            columns={keyColumns}
            rows={data.keys}
            rowKey={row => row.id}
            emptyState={
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="text-sm text-muted-foreground" dir="auto">
                  {t('empty.body')}
                </p>
              </div>
            }
          />
        ) : null}
      </div>

      {/* ── Create ──────────────────────────────────────────────────────── */}
      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title={t('create.title')}>
        <div className="space-y-3">
          <label className="block text-xs font-medium text-foreground" dir="auto">
            {t('create.nameLabel')}
            <input
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('create.namePlaceholder')}
              maxLength={64}
              dir="auto"
            />
          </label>

          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-foreground" dir="auto">
              {t('create.scopesLabel')}
            </legend>
            <p className="text-[11px] leading-relaxed text-muted-foreground" dir="auto">
              {t('create.scopesHelp')}
            </p>
            {SCOPE_ORDER.map(scope => (
              <label key={scope} className="flex items-start gap-2 text-xs" dir="auto">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span>
                  <code className="font-mono text-[11px]" dir="ltr">
                    {scope}
                  </code>
                  <span className="block text-muted-foreground">
                    {t(`create.scope.${scope.replace('merchant:', '')}`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="block text-xs font-medium text-foreground" dir="auto">
            {t('create.expiryLabel')}
            <input
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
              value={expiresInDays}
              onChange={e => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={t('create.expiryPlaceholder')}
              inputMode="numeric"
              dir="ltr"
            />
          </label>

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={busy !== null}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void mint()}
              isLoading={busy === 'mint'}
              // An unnamed key is unrecognisable in the list, and a key with no
              // scope authorises nothing — neither is a useful thing to mint.
              disabled={busy !== null || name.trim().length === 0 || scopes.length === 0}
            >
              {t('actions.mint')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── One-time reveal ─────────────────────────────────────────────────
          `onClose` is the same dismissal as the button: whichever way the
          merchant leaves, the key is gone. */}
      <Modal isOpen={minted !== null} onClose={dismissReveal} title={t('reveal.title')} size="lg">
        <div className="space-y-3">
          <p
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
            dir="auto"
          >
            {t('reveal.warning')}
          </p>
          {/* Forced LTR + break-all: a base64url secret must never be
              bidi-reordered or wrapped mid-glyph in an Arabic admin. */}
          <code
            className="block w-full rounded-lg border bg-muted px-3 py-2 font-mono text-xs break-all text-foreground"
            dir="ltr"
          >
            {minted?.apiKey}
          </code>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer" dir="auto">
              {t('reveal.configSummary')}
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 text-[11px]" dir="ltr">
              {JSON.stringify(
                {
                  mcpServers: {
                    'my-store': {
                      type: 'http',
                      // `getApiUrl()`, not string surgery on the admin origin.
                      // `.replace('admin.', 'api.')` only ever worked on an
                      // `admin.` host: on store.ebda.app it is a no-op and the
                      // merchant copies the merchant-app worker's host, which
                      // is not the API. This snippet is the only artifact
                      // handed over alongside a secret that can never be shown
                      // again — a merchant who pastes a wrong host gets a 404
                      // from a surface designed to 404 at everything, with no
                      // way to re-read the key and retry.
                      url: `${getApiUrl()}/api/v1/mcp/admin/${data?.storeSlug ?? '<store-slug>'}`,
                      headers: { [minted?.header ?? 'x-merchant-key']: minted?.apiKey ?? '' },
                    },
                  },
                },
                null,
                2
              )}
            </pre>
          </details>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void copyKey()}>
              {copied ? t('reveal.copied') : t('reveal.copy')}
            </Button>
            <Button type="button" size="sm" onClick={dismissReveal}>
              {t('reveal.done')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Revoke confirmation ─────────────────────────────────────────── */}
      <Modal
        isOpen={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={t('revoke.title')}
      >
        <div className="space-y-3">
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-foreground"
            dir="auto"
          >
            {t('revoke.body', { name: revokeTarget?.name ?? '' })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={busy !== null}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => revokeTarget && void revoke(revokeTarget)}
              isLoading={busy === revokeTarget?.id}
              disabled={busy !== null}
            >
              {t('revoke.confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </AdminLayout>
  );
}
