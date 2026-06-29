'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, Badge, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Alert } from '../../../../components/Alert';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';
import { useT } from '@/i18n/useT';

export default function StoreDomainPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('domain.page');
  const { store, isLoading, refetch: refetchStore } = useCurrentStore(storeId);

  // ----- Domain section state -----
  const [isEditing, setIsEditing] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [domainStatus, setDomainStatus] = useState<{
    domain: string;
    verified: boolean;
    misconfigured: boolean;
    dnsRecords: Array<{
      type: string;
      name: string;
      value: string;
      priority?: number;
      ttl?: string;
    }>;
    emailSender?: { domainId: string | null; status: string | null; verifiedAt: string | null };
  } | null>(null);
  const [domainError, setDomainError] = useState('');

  // Returns the latest fetched data so callers (e.g. the verify polling
  // loop) can branch on the live response without dealing with React's
  // state-update timing. Side effect: also pushes the data into local
  // state so the UI re-renders.
  const checkDns = useCallback(async () => {
    if (!store?.domain) return null;
    setIsChecking(true);
    try {
      const { data } = await apiGet<{
        domain: string;
        verified: boolean;
        misconfigured: boolean;
        dnsRecords: Array<{
          type: string;
          name: string;
          value: string;
          priority?: number;
          ttl?: string;
        }>;
        emailSender?: { domainId: string | null; status: string | null; verifiedAt: string | null };
      }>(`/api/v1/stores/${storeId}/domain`);
      if (data) setDomainStatus(data);
      return data ?? null;
    } catch {
      // non-critical
      return null;
    } finally {
      setIsChecking(false);
    }
  }, [store?.domain, storeId]);

  useEffect(() => {
    if (store?.domain) checkDns();
  }, [store?.domain, checkDns]);

  async function handleSaveDomain() {
    const trimmed = newDomain.trim().toLowerCase();
    if (
      trimmed &&
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)
    ) {
      setDomainError(t('invalidDomain'));
      return;
    }
    setIsSaving(true);
    setDomainError('');
    try {
      const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/domain`, {
        domain: trimmed || null,
      });
      if (!apiError) {
        setIsEditing(false);
        await refetchStore();
        if (trimmed) setTimeout(checkDns, 1000);
        else setDomainStatus(null);
      } else {
        setDomainError(apiError.message || t('updateFailed'));
      }
    } catch {
      setDomainError(t('updateFailed'));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemoveDomain() {
    setNewDomain('');
    setIsSaving(true);
    try {
      const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/domain`, {
        domain: null,
      });
      if (!apiError) {
        setDomainStatus(null);
        setIsEditing(false);
        await refetchStore();
      }
    } catch {
      // non-critical
    } finally {
      setIsSaving(false);
    }
  }

  const [isProvisioningEmail, setIsProvisioningEmail] = useState(false);
  const [isVerifyingEmail, setIsVerifyingEmail] = useState(false);
  const [emailSenderError, setEmailSenderError] = useState('');

  async function handleProvisionEmailSender() {
    setIsProvisioningEmail(true);
    setEmailSenderError('');
    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/email-sender/provision`,
        {}
      );
      if (apiError) {
        setEmailSenderError(apiError.message || t('emailSenderError'));
      } else {
        await checkDns();
      }
    } catch {
      setEmailSenderError(t('emailSenderError'));
    } finally {
      setIsProvisioningEmail(false);
    }
  }

  async function handleVerifyEmailSender() {
    setIsVerifyingEmail(true);
    setEmailSenderError('');
    try {
      // Step 1: kick off Resend verification (POST /verify → POST to
      // Resend's own /domains/:id/verify). Returns immediately; Resend
      // then polls DNS asynchronously and flips status to 'verified'
      // when all three records check out.
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/email-sender/verify`,
        {}
      );
      if (apiError) {
        setEmailSenderError(apiError.message || t('emailSenderError'));
        return;
      }

      // Step 2: poll for the resulting status. Resend's verification
      // window is typically <30s when DNS is already published (common
      // case — merchant added records, waited, then clicked Verify),
      // and up to ~2 minutes when DNS just propagated. Polling at
      // 3s/8s/15s/30s/60s gives 5 checks across ~2 minutes; we break
      // as soon as status === 'verified'. Each tick uses checkDns()
      // which also updates the local UI state, so the badge + Sending
      // As line refresh in-place without a hard page reload.
      const intervals = [3000, 8000, 15000, 30000, 60000];
      for (const ms of intervals) {
        await new Promise(resolve => setTimeout(resolve, ms));
        const latest = await checkDns();
        if (latest?.emailSender?.status === 'verified') {
          break;
        }
        // 'failed' is terminal — Resend won't auto-retry. Surface the
        // error and stop polling so the merchant can fix DNS + click
        // Verify again to re-trigger.
        if (latest?.emailSender?.status === 'failed') {
          setEmailSenderError(t('emailSenderError'));
          break;
        }
      }
    } catch {
      setEmailSenderError(t('emailSenderError'));
    } finally {
      setIsVerifyingEmail(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
        <div className="mx-auto max-w-4xl p-6">
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  if (!store) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
        <div className="mx-auto max-w-4xl p-6">
          <p className="text-muted-foreground">{t('storeNotFound')}</p>
        </div>
      </AdminLayout>
    );
  }

  const domain = store.domain;

  const senderPreview = (() => {
    const name = store?.name ?? '';
    // Read the SEO-configured sender prefix so the DNS-setup preview matches
    // the address real mail is sent from (resend.service uses the same field).
    // Falls back to 'noreply' — the same column default — when unset.
    const localPart = store?.emailSenderLocalPart || 'noreply';
    const verifiedCustom = domainStatus?.emailSender?.status === 'verified' && !!store?.domain;
    // Must match PLATFORM_EMAIL_DOMAIN in apps/api/src/services/email-sender.ts
    const host = verifiedCustom ? store!.domain : 'force-ai.co';
    return `${name} <${localPart}@${host}>`;
  })();

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">{t('heading')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>

        <div className="rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-foreground">
              {store.name} {t('storeDomainSuffix')}
            </h2>
            <div className="flex gap-2">
              {!isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setNewDomain(domain || '');
                    setIsEditing(true);
                    setDomainError('');
                  }}
                >
                  {domain ? t('changeDomain') : t('addDomain')}
                </Button>
              )}
              {domain && !isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveDomain}
                  disabled={isSaving}
                >
                  {t('remove')}
                </Button>
              )}
            </div>
          </div>
          <div className="p-6">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="domain">{t('domain')}</Label>
                  <Input
                    id="domain"
                    value={newDomain}
                    onChange={e => {
                      setNewDomain(e.target.value.toLowerCase());
                      setDomainError('');
                    }}
                    placeholder={t('domainPlaceholder')}
                    className={`mt-1 ${domainError ? 'border-destructive' : ''}`}
                  />
                  {domainError && <p className="mt-1 text-sm text-destructive">{domainError}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{t('domainRemoveHint')}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveDomain} disabled={isSaving}>
                    {isSaving ? t('saving') : t('save')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsEditing(false);
                      setDomainError('');
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : domain ? (
              (() => {
                // Three states based on Vercel's domain API:
                //   verified=false              → "pending" — DNS records not added yet
                //   verified=true, misconfig=t  → "dns-not-pointing" — Vercel owns the
                //                                  cert/config but the live A/CNAME
                //                                  resolves elsewhere (registrar parking
                //                                  page, old AWS pointer, etc.). The
                //                                  Vercel UI calls this "configured by
                //                                  another A record". Without this state
                //                                  the admin would show a green "live at
                //                                  https://X" message while customers
                //                                  visiting X actually land on the
                //                                  registrar parking page — what bit us
                //                                  on wadyaljuz.com 2026-05-13.
                //   verified=true, misconfig=f  → "live" — true end-to-end pointing at us
                const isVerified = domainStatus?.verified === true;
                const isMisconfigured = domainStatus?.misconfigured === true;
                const isFullyLive = isVerified && !isMisconfigured;
                const isDnsPointingWrong = isVerified && isMisconfigured;
                // Records table visibility: show whenever ANY DNS work is
                // pending — storefront (A/CNAME) OR email (MX/DKIM/SPF).
                // The single panel mixes both record families; if we hide
                // it the moment storefront goes live, the email DNS rows
                // disappear too and the merchant loses the panel mid-setup
                // (caught on wadyaljuz.com 2026-05-14 — records flashed
                // in then disappeared on every page refresh).
                const emailVerified = domainStatus?.emailSender?.status === 'verified';
                const needsDnsRecords = !isFullyLive || !emailVerified;
                return (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <p className="font-medium text-foreground">{domain}</p>
                      <Badge
                        variant={
                          isFullyLive ? 'default' : isDnsPointingWrong ? 'secondary' : 'secondary'
                        }
                      >
                        {isFullyLive
                          ? t('verified')
                          : isDnsPointingWrong
                            ? t('dnsPointingTitle')
                            : t('pending')}
                      </Badge>
                    </div>

                    {needsDnsRecords && (
                      <Alert
                        variant="warning"
                        title={isDnsPointingWrong ? t('dnsPointingTitle') : t('dnsRequired')}
                      >
                        <p className="mt-1 text-sm">
                          {isDnsPointingWrong ? t('dnsPointingMessage') : t('dnsInstructions')}
                        </p>
                        <div className="mt-3 overflow-hidden rounded-md border border-warning/40 bg-background">
                          <table className="w-full text-sm" aria-label={t('dnsTableLabel')}>
                            <thead>
                              <tr className="border-b border-warning/40 bg-warning/10">
                                <th scope="col" className="px-3 py-2 text-start font-medium">
                                  {t('colType')}
                                </th>
                                <th scope="col" className="px-3 py-2 text-start font-medium">
                                  {t('colName')}
                                </th>
                                <th scope="col" className="px-3 py-2 text-start font-medium">
                                  {t('colValue')}
                                </th>
                                <th scope="col" className="px-3 py-2 text-start font-medium">
                                  {t('colPriority')}
                                </th>
                                <th scope="col" className="px-3 py-2 text-start font-medium">
                                  {t('colTtl')}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {domainStatus?.dnsRecords?.map((record, i) => (
                                <tr key={i} className="border-b border-warning/20 last:border-0">
                                  <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap">
                                    {record.type}
                                  </td>
                                  <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap">
                                    {record.name}
                                  </td>
                                  <td className="px-3 py-2 font-mono text-xs align-top break-all">
                                    {/* DKIM TXT values (resend._domainkey) are ~400-char
                                        base64 strings — without `break-all` the cell
                                        either truncates with overflow:hidden or runs
                                        off the right edge of the layout. `align-top`
                                        keeps short cells (type, name, priority, ttl)
                                        aligned with the first line of the wrapped value. */}
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="flex-1 min-w-0 select-all">
                                        {record.value}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          void navigator.clipboard.writeText(record.value);
                                        }}
                                        className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted transition-colors"
                                        aria-label={`Copy ${record.type} value`}
                                        title="Copy"
                                      >
                                        Copy
                                      </button>
                                    </div>
                                  </td>
                                  {/* MX records require a priority at registrars; for
                                      all other types the field is left empty so the
                                      merchant doesn't try to enter something. */}
                                  <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap text-muted-foreground">
                                    {typeof record.priority === 'number'
                                      ? record.priority
                                      : record.type === 'MX'
                                        ? 10
                                        : '—'}
                                  </td>
                                  {/* TTL defaults to 1 hour (3600) when the provider
                                      didn't return one — that's the GoDaddy default
                                      and the safe value for every DNS record. */}
                                  <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap text-muted-foreground">
                                    {record.ttl ?? '1 Hour'}
                                  </td>
                                </tr>
                              )) ||
                                // Fallback when the API returned no records (e.g.
                                // Vercel unreachable). Apex domains get the simple
                                // single A record — most registrars allow it
                                // without lockouts. The www variant is auto-attached
                                // at the Vercel project level, so the merchant
                                // never needs to set a CNAME on `www` (which
                                // GoDaddy and similar registrars often lock).
                                (domain.split('.').filter(Boolean).length === 2 ? (
                                  <tr>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap">
                                      A
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap">
                                      @
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top break-all">
                                      76.76.21.21
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap text-muted-foreground">
                                      —
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap text-muted-foreground">
                                      1 Hour
                                    </td>
                                  </tr>
                                ) : (
                                  <tr>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap">
                                      CNAME
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap">
                                      {domain}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top break-all">
                                      cf.force-ai.co
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap text-muted-foreground">
                                      —
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap text-muted-foreground">
                                      1 Hour
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <p className="text-xs opacity-80">{t('dnsPropagation')}</p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={checkDns}
                            disabled={isChecking}
                          >
                            {isChecking ? t('checkingDns') : t('checkDns')}
                          </Button>
                        </div>
                      </Alert>
                    )}

                    {isFullyLive && (
                      <p className="text-sm text-success">{t('verifiedMessage', { domain })}</p>
                    )}

                    {/* www auto-attach feedback — the platform's
                        VercelDomainService.addDomain() attaches the www
                        variant alongside the apex automatically (commit
                        0e2ba67). without surfacing that here, merchants
                        worry / try to set up www themselves at the
                        registrar even though it just works. only show
                        on apex domains (2-part: example.com), not on
                        subdomain attachments where there's no implicit
                        www variant. */}
                    {domain.split('.').filter(Boolean).length === 2 && (
                      <Alert variant="info" title={t('wwwAutoAttachedTitle')}>
                        <p className="mt-1 text-sm">{t('wwwAutoAttachedMessage', { domain })}</p>
                      </Alert>
                    )}
                  </div>
                );
              })()
            ) : (
              <p className="text-sm text-muted-foreground">{t('noDomain')}</p>
            )}
          </div>
        </div>

        {/* Email sender card */}
        <div className="mt-6 rounded-lg border border-border bg-card p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-foreground">{t('emailSenderTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('emailSenderSubtitle')}</p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t('sendingAs')}</p>
                <p className="font-mono text-sm text-foreground">{senderPreview}</p>
              </div>
              <Badge
                variant={
                  domainStatus?.emailSender?.status === 'verified'
                    ? 'default'
                    : domainStatus?.emailSender?.status === 'pending' ||
                        domainStatus?.emailSender?.status === 'not_started'
                      ? 'secondary'
                      : 'outline'
                }
              >
                {domainStatus?.emailSender?.status === 'verified'
                  ? t('statusVerified')
                  : domainStatus?.emailSender?.status === 'pending' ||
                      domainStatus?.emailSender?.status === 'not_started'
                    ? t('statusPending')
                    : domainStatus?.emailSender?.status === 'failed'
                      ? t('statusFailed')
                      : t('statusNotConfigured')}
              </Badge>
            </div>

            {emailSenderError && <p className="text-sm text-destructive">{emailSenderError}</p>}

            {!domainStatus?.emailSender?.domainId && domain && (
              <Button onClick={handleProvisionEmailSender} disabled={isProvisioningEmail}>
                {isProvisioningEmail ? t('settingUp') : t('setupBrandedEmail')}
              </Button>
            )}

            {/* Resend's domain status moves through not_started -> pending ->
                verified (or failed). The provision endpoint creates the domain
                row in `not_started` state — DNS records are returned but Resend
                isn't yet polling. The merchant adds the DNS records at their
                registrar, then clicks Verify which asks Resend to start the
                verification cycle (status becomes 'pending' while DNS resolves,
                then 'verified' once all three records check out). Showing the
                Verify button on BOTH states means the merchant has a path from
                either "I just set it up" or "Resend's still checking" — no
                stuck state. */}
            {(domainStatus?.emailSender?.status === 'pending' ||
              domainStatus?.emailSender?.status === 'not_started') && (
              <Button
                variant="outline"
                onClick={handleVerifyEmailSender}
                disabled={isVerifyingEmail}
              >
                {isVerifyingEmail ? t('verifying') : t('verifyEmailSender')}
              </Button>
            )}

            {/* Failed state: re-verify path. Resend marks failed when DNS
                records didn't resolve during the verification window — the
                merchant fixes them at their registrar and clicks Verify again. */}
            {domainStatus?.emailSender?.status === 'failed' && (
              <Button
                variant="outline"
                onClick={handleVerifyEmailSender}
                disabled={isVerifyingEmail}
              >
                {isVerifyingEmail ? t('verifying') : t('verifyEmailSender')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
