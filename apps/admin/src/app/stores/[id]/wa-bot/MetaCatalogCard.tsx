'use client';

/**
 * MetaCatalogCard — form for Meta Commerce Catalog credentials.
 *
 * The access token is write-only: once saved, the field shows "Token set ✓"
 * and the user must type a new value to rotate it. The current token is NEVER
 * returned to the browser (hasMetaToken boolean only).
 *
 * Saves via PUT /api/v1/stores/:id/integrations/wbs { metaCatalogId, metaBusinessId, metaAccessToken }.
 */

import { useState } from 'react';
import { Button, useToast } from '@force/ui';
import { apiPost, apiPut } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import type { MetaCatalogConfig } from '../../../../lib/types/wa-bot';

interface MetaCatalogCardProps {
  storeId: string;
  initialConfig: MetaCatalogConfig;
}

interface ProvisionResponse {
  metaCatalogId: string | null;
  metaBusinessId: string | null;
  hasMetaToken: boolean;
}

export function MetaCatalogCard({ storeId, initialConfig }: MetaCatalogCardProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [catalogId, setCatalogId] = useState(initialConfig.metaCatalogId ?? '');
  const [businessId, setBusinessId] = useState(initialConfig.metaBusinessId ?? '');
  const [accessToken, setAccessToken] = useState(''); // always start blank — never pre-fill
  const [hasToken, setHasToken] = useState(initialConfig.hasMetaToken);
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState(false);

  const handleSave = async () => {
    setSaving(true);

    const body: Record<string, string | null> = {
      metaCatalogId: catalogId.trim() || null,
      metaBusinessId: businessId.trim() || null,
    };

    // Only include access token in the payload if the user typed something new.
    // An empty string = "no change". null would clear the token — we don't offer
    // a clear button here; the merchant just rotates by typing a new value.
    if (accessToken.trim()) {
      body.metaAccessToken = accessToken.trim();
    }

    const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, body);
    setSaving(false);

    if (error) {
      toastError(error.message || 'Failed to save Meta catalog config');
    } else {
      toastSuccess('Meta catalog config saved');
      // Clear the token input — it was accepted, never show it again
      if (accessToken.trim()) {
        setAccessToken('');
        setHasToken(true);
      }
    }
  };

  const handleAutoProvision = async () => {
    const alreadyProvisioned = catalogId.trim().length > 0;
    const confirmMsg = alreadyProvisioned
      ? 'A catalog id is already filled in. Clear it first if you really want to provision a new one. Continue anyway?'
      : 'This will call Meta Graph API to create a brand-new Commerce Catalog under the Force AI parent Business Manager and assign it to this store. Continue?';
    if (!window.confirm(confirmMsg)) return;

    setProvisioning(true);
    const { data, error } = await apiPost<ProvisionResponse>(
      `/api/v1/stores/${storeId}/integrations/wbs/provision-meta-catalog`
    );
    setProvisioning(false);

    if (error) {
      toastError(error.message || 'Meta auto-provisioning failed');
      return;
    }
    if (!data) return;

    setCatalogId(data.metaCatalogId ?? '');
    setBusinessId(data.metaBusinessId ?? '');
    setHasToken(data.hasMetaToken);
    setAccessToken('');
    toastSuccess('Meta catalog provisioned — submit it for Meta review next.');
  };

  const isDirty =
    catalogId.trim() !== (initialConfig.metaCatalogId ?? '') ||
    businessId.trim() !== (initialConfig.metaBusinessId ?? '') ||
    accessToken.trim().length > 0;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">Meta Commerce Catalog</h2>
      <p className="text-sm text-muted-foreground mb-5">
        Required for <span className="font-medium">Native Catalog</span> bot modes. Find these IDs
        in your{' '}
        <a
          href="https://business.facebook.com/commerce"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline"
        >
          Meta Business Manager
        </a>
        .
      </p>

      <div className="space-y-4">
        {/* Catalog ID */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Catalog ID</label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder="e.g. 123456789012345"
            value={catalogId}
            onChange={e => setCatalogId(e.target.value)}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            From Meta Commerce Manager → Catalog Settings.
          </p>
        </div>

        {/* Business ID */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Business Account ID
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder="e.g. 987654321098765"
            value={businessId}
            onChange={e => setBusinessId(e.target.value)}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            From Meta Business Manager → Business Settings → Business Info.
          </p>
        </div>

        {/* Access Token — write-only */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            System User Access Token
          </label>
          {hasToken && !accessToken && (
            // Neutral, not green: a token string is stored, but FWB does not
            // validate it live against Meta (it may be expired/revoked or have
            // lost the catalog_management scope). Don't imply "verified".
            <div className="mb-2 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/40">
              <svg
                className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-600 dark:text-slate-300">
                Token saved · not verified
              </span>
            </div>
          )}
          <input
            type="password"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder={
              hasToken ? 'Type a new token to rotate it' : 'Paste your System User token'
            }
            value={accessToken}
            onChange={e => setAccessToken(e.target.value)}
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Create a System User in Meta Business Manager → grant{' '}
            <code className="bg-muted rounded px-1">catalog_management</code> permission. Token is
            encrypted at rest and never shown again after saving.
          </p>
        </div>
      </div>

      {isSuperAdmin && (
        <div className="mt-5 rounded-md border border-dashed border-primary/40 bg-primary/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Provision automatically · Force AI assisted
                <span className="ms-1.5 text-xs font-normal text-muted-foreground">
                  / إعداد تلقائي · مُدار بواسطة Force AI
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Creates a new Commerce Catalog under the Force AI parent Business Manager and fills
                in the three fields above. Saves the merchant from navigating Meta Business Manager.
                You still need to submit the catalog for Meta review afterwards.
              </p>
            </div>
            <Button
              onClick={handleAutoProvision}
              disabled={provisioning}
              size="sm"
              variant="outline"
              className="shrink-0"
            >
              {provisioning ? 'Provisioning…' : 'Provision automatically'}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
