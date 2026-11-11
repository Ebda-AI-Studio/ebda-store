'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, Badge, Input, Label } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useConfirm } from '../../../../hooks/useConfirm';
import { Alert } from '../../../../components/Alert';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { BRAND } from '@ebda/shared';

interface DnsRecordRow {
  type: string;
  name: string;
  value: string;
  priority?: number;
  ttl?: string;
}

export default function StoreDomainPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('domain.page');
  const askConfirm = useConfirm();
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
    claimStatus?: 'pending' | 'active' | 'failed' | null;
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
  const [copiedAll, setCopiedAll] = useState(false);

  /** Every record as plain tab-separated lines: paste into a chat or a registrar ticket. */
  const recordsAsText = (rows: Array<{ type: string; name: string; value: string }>) =>
    rows.map(r => `${r.type}\t${r.name}\t${r.value}`).join('\n');
  async function copyAllRecords(rows: Array<{ type: string; name: string; value: string }>) {
    try {
      await navigator.clipboard.writeText(recordsAsText(rows));
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    } catch {
      /* clipboard blocked: the per-row copy buttons still work */
    }
  }
  /** A ready email the merchant sends to whoever manages the domain (a developer, the registrar's support). */
  const emailInstructionsHref = (rows: Array<{ type: string; name: string; value: string }>) =>
    `mailto:?subject=${encodeURIComponent(t('emailSubject'))}&body=${encodeURIComponent(
      `${t('emailBody')}\n\n${recordsAsText(rows)}`
    )}`;

  // Returns the latest fetched data so callers (e.g. the verify polling
  // loop) can branch on the live response without dealing with React's
  // state-update timing. Side effect: also pushes the data into local
  // state so the UI re-renders.
  // The hostname being worked on: an unverified claim, else the verified domain.
  const claimed = store?.pendingDomain ?? store?.domain ?? null;
  const claimStatus = store?.domainStatus ?? null;

  const checkDns = useCallback(async () => {
    if (!claimed) return null;
    setIsChecking(true);
    try {
      const { data } = await apiGet<{
        domain: string;
        verified: boolean;
        misconfigured: boolean;
        claimStatus?: 'pending' | 'active' | 'failed' | null;
        dnsRecords: Array<{
          type: string;
          name: string;
          value: string;
          priority?: number;
          ttl?: string;
        }>;
        emailSender?: { domainId: string | null; status: string | null; verifiedAt: string | null };
      }>(`/api/v1/stores/${storeId}/domain`);
      if (data) {
        setDomainStatus(data);
        // The status read promotes a verified claim server-side: pick up the new
        // `domain` / `domainStatus` so the page flips from "pending" to live.
        if (data.claimStatus === 'active' && store?.domainStatus === 'pending') {
          void refetchStore();
        }
      }
      return data ?? null;
    } catch {
      // non-critical
      return null;
    } finally {
      setIsChecking(false);
    }
  }, [claimed, storeId, store?.domainStatus, refetchStore]);

  useEffect(() => {
    if (claimed) checkDns();
  }, [claimed, checkDns]);

  // While a claim is pending, re-check every 30s (DCV usually lands within minutes).
  useEffect(() => {
    if (claimStatus !== 'pending') return;
    const timer = setInterval(() => void checkDns(), 30_000);
    return () => clearInterval(timer);
  }, [claimStatus, checkDns]);

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
    const ok = await askConfirm({
      object: t('removeObject', { domain: store?.domain ?? store?.pendingDomain ?? '' }),
      consequence: t('removeConsequence'),
      confirmLabel: t('removeLabel'),
      tone: 'danger',
    });
    if (!ok) return;
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

  const domain = claimed ?? undefined;

  const senderPreview = (() => {
    const name = store?.name ?? '';
    // Read the SEO-configured sender prefix so the DNS-setup preview matches
    // the address real mail is sent from (store-mailer uses the same field).
    // Falls back to 'orders'; the address is <prefix>.<slug>@ebda.app (email-sender.ts).
    const prefixes = ['orders', 'receipts', 'hello', 'info', 'support'];
    const chosen = store?.emailSenderLocalPart ?? '';
    const localPart = `${prefixes.includes(chosen) ? chosen : 'orders'}.${store?.slug ?? 'store'}`;
    const verifiedCustom = domainStatus?.emailSender?.status === 'verified' && !!store?.domain;
    // Must match PLATFORM_EMAIL_DOMAIN in apps/api/src/services/email-sender.ts
    const host = verifiedCustom ? store!.domain : BRAND.domains.marketing;
    return `${name} <${localPart}@${host}>`;
  })();

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
      <div className="mx-auto max-w-4xl p-6">
        {(claimStatus === 'pending' || claimStatus === 'failed') && domain && (
          <div
            role="status"
            className={`mb-4 rounded-lg border p-3 text-sm ${
              claimStatus === 'failed'
                ? 'border-destructive/30 bg-destructive/10 text-destructive-ink'
                : 'border-warning/30 bg-warning/10 text-foreground'
            }`}
          >
            {claimStatus === 'failed'
              ? t('claimFailed', { domain })
              : t('claimPending', { domain })}
          </div>
        )}

        <div className="rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-foreground">
              {t('storeDomainTitle', { name: store.name })}
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
                  className="text-destructive-ink"
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
                  {domainError && (
                    <p className="mt-1 text-sm text-destructive-ink">{domainError}</p>
                  )}
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
                // Three states based on the Cloudflare-for-SaaS custom hostname API:
                //   verified=false              → "pending" — DNS records not added yet
                //   verified=true, misconfig=t  → "dns-not-pointing" — Cloudflare owns
                //                                  the cert/config but the live CNAME
                //                                  resolves elsewhere (registrar parking
                //                                  page, old A record, etc.). Without
                //                                  this state the admin would show a
                //                                  green "live at https://X" message
                //                                  while customers visiting X actually
                //                                  land on the registrar parking page —
                //                                  what bit us on demo-shop.example 2026-05-13.
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
                // (caught on demo-shop.example 2026-05-14 — records flashed
                // in then disappeared on every page refresh).
                const emailVerified = domainStatus?.emailSender?.status === 'verified';
                const needsDnsRecords = !isFullyLive || !emailVerified;
                // Cloudflare-for-SaaS uses a single CNAME regardless of apex or
                // subdomain — the fallback row only appears when the API returned
                // no records at all (undefined/null), not when it returned an
                // empty array (matches the original `.map() || fallback` behavior).
                const dnsRows: DnsRecordRow[] = domainStatus?.dnsRecords ?? [
                  { type: 'CNAME', name: domain, value: `cf${BRAND.domains.storeSuffix}` },
                ];
                const dnsColumns: DataTableColumn<DnsRecordRow>[] = [
                  {
                    header: t('colType'),
                    mobileBadge: true,
                    className: 'whitespace-nowrap',
                    cell: record => <span className="font-mono text-xs">{record.type}</span>,
                  },
                  {
                    header: t('colName'),
                    primaryOnMobile: true,
                    className: 'whitespace-nowrap',
                    cell: record => <span className="font-mono text-xs">{record.name}</span>,
                  },
                  {
                    header: t('colValue'),
                    cell: record => (
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex-1 min-w-0 select-all font-mono text-xs break-all">
                          {record.value}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(record.value);
                          }}
                          className="max-md:min-h-11 max-md:min-w-11 shrink-0 rounded border border-border bg-background px-2 py-0.5 max-md:px-3 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                          aria-label={t('copyValueAriaLabel', { type: record.type })}
                          title={t('copy')}
                        >
                          {t('copy')}
                        </button>
                      </div>
                    ),
                  },
                  {
                    header: t('colPriority'),
                    className: 'whitespace-nowrap',
                    cell: record => (
                      <span className="font-mono text-xs text-muted-foreground">
                        {typeof record.priority === 'number'
                          ? record.priority
                          : record.type === 'MX'
                            ? 10
                            : '—'}
                      </span>
                    ),
                  },
                  {
                    header: t('colTtl'),
                    className: 'whitespace-nowrap',
                    cell: record => (
                      <span className="font-mono text-xs text-muted-foreground">
                        {record.ttl ?? t('ttlAuto')}
                      </span>
                    ),
                  },
                ];
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
                        title={
                          isDnsPointingWrong
                            ? t('dnsPointingTitle')
                            : !isVerified
                              ? t('dnsWaitingTitle')
                              : t('dnsEmailTitle')
                        }
                      >
                        <p className="mt-1 text-sm">
                          {isDnsPointingWrong
                            ? t('dnsPointingMessage')
                            : !isVerified
                              ? t('dnsWaitingMessage')
                              : t('dnsInstructions')}
                        </p>
                        <div className="mt-3">
                          <DataTable<DnsRecordRow>
                            ariaLabel={t('dnsTableLabel')}
                            columns={dnsColumns}
                            rows={dnsRows}
                            rowKey={(record, i) => `${record.type}-${record.name}-${i}`}
                          />
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-11"
                            onClick={() => void copyAllRecords(dnsRows)}
                          >
                            {copiedAll ? t('copiedAll') : t('copyAll')}
                          </Button>
                          <a
                            href={emailInstructionsHref(dnsRows)}
                            className="inline-flex min-h-11 items-center text-sm font-medium text-primary-ink underline underline-offset-2"
                          >
                            {t('emailInstructions')}
                          </a>
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
                      <p className="text-sm text-success-ink">{t('verifiedMessage', { domain })}</p>
                    )}

                    {/* www auto-attach feedback — the platform's
                        CloudflareDomainService.addDomain() attaches the www
                        variant alongside the apex automatically. without
                        surfacing that here, merchants worry / try to set up
                        www themselves at the registrar even though it just
                        works. only show on apex domains (2-part:
                        example.com), not on subdomain attachments where
                        there's no implicit www variant. */}
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
            <h2
              data-setting-id="domain.email-sender"
              className="text-lg font-semibold text-foreground"
            >
              {t('emailSenderTitle')}
            </h2>
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

            {emailSenderError && <p className="text-sm text-destructive-ink">{emailSenderError}</p>}

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
