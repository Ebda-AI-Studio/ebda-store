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
import { useT } from '../../../../i18n/useT';

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
  const t = useT('whatsappIntegration.metaCatalog');
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
      toastError(error.message || t('saveError'));
    } else {
      toastSuccess(t('saveSuccess'));
      // Clear the token input — it was accepted, never show it again
      if (accessToken.trim()) {
        setAccessToken('');
        setHasToken(true);
      }
    }
  };

  const handleAutoProvision = async () => {
    const alreadyProvisioned = catalogId.trim().length > 0;
    const confirmMsg = alreadyProvisioned ? t('confirmAlready') : t('confirmNew');
    if (!window.confirm(confirmMsg)) return;

    setProvisioning(true);
    const { data, error } = await apiPost<ProvisionResponse>(
      `/api/v1/stores/${storeId}/integrations/wbs/provision-meta-catalog`
    );
    setProvisioning(false);

    if (error) {
      toastError(error.message || t('provisionError'));
      return;
    }
    if (!data) return;

    setCatalogId(data.metaCatalogId ?? '');
    setBusinessId(data.metaBusinessId ?? '');
    setHasToken(data.hasMetaToken);
    setAccessToken('');
    toastSuccess(t('provisionSuccess'));
  };

  const isDirty =
    catalogId.trim() !== (initialConfig.metaCatalogId ?? '') ||
    businessId.trim() !== (initialConfig.metaBusinessId ?? '') ||
    accessToken.trim().length > 0;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">{t('title')}</h2>
      <p className="text-sm text-muted-foreground mb-5">
        {t.rich('subtitle', {
          b: chunks => <span className="font-medium">{chunks}</span>,
          manager: chunks => (
            <a
              href="https://business.facebook.com/commerce"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              {chunks}
            </a>
          ),
        })}
      </p>

      <div className="space-y-4">
        {/* Catalog ID */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('catalogId')}</label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder={t('catalogIdPlaceholder')}
            value={catalogId}
            onChange={e => setCatalogId(e.target.value)}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('catalogIdHint')}</p>
        </div>

        {/* Business ID */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('businessId')}
          </label>
          <input
            type="text"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder={t('businessIdPlaceholder')}
            value={businessId}
            onChange={e => setBusinessId(e.target.value)}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('businessIdHint')}</p>
        </div>

        {/* Access Token — write-only */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('accessToken')}
          </label>
          {hasToken && !accessToken && (
            // Neutral, not green: a token string is stored, but Ebda does not
            // validate it live against Meta (it may be expired/revoked or have
            // lost the catalog_management scope). Don't imply "verified".
            <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
              <svg
                className="h-4 w-4 shrink-0 text-muted-foreground"
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
              <span className="text-sm text-muted-foreground">{t('accessTokenSaved')}</span>
            </div>
          )}
          <input
            type="password"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder={
              hasToken ? t('accessTokenPlaceholderRotate') : t('accessTokenPlaceholderNew')
            }
            value={accessToken}
            onChange={e => setAccessToken(e.target.value)}
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t.rich('accessTokenHint', {
              code: chunks => <code className="bg-muted rounded px-1">{chunks}</code>,
            })}
          </p>
        </div>
      </div>

      {isSuperAdmin && (
        <div className="mt-5 rounded-md border border-dashed border-primary/40 bg-primary/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('provisionTitle')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('provisionDescription')}</p>
            </div>
            <Button
              onClick={handleAutoProvision}
              disabled={provisioning}
              size="sm"
              variant="outline"
              className="shrink-0"
            >
              {provisioning ? t('provisioning') : t('provisionButton')}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  );
}
