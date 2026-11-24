'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useFeatures } from '../../../../hooks/useFeatures';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { apiGet, apiPatch } from '../../../../lib/api';
import { SubscriptionPlanRow } from '../../../../components/billing/SubscriptionPlanRow';
import { SettingsSearch } from '../../../../components/SettingsSearch';
import { SETTINGS_GROUPS } from '../../../../lib/settings-groups';
import { OwnerStoreLifecycle } from './_components/OwnerStoreLifecycle';
import { ConnectChatCard } from './ConnectChatCard';

/**
 * Fetches the store theme and surfaces the aiAutopilot flag as a small
 * status chip on the Branding card. aiAutopilot defaults ON (undefined = ON),
 * so the chip reflects the active state without requiring a separate API call
 * — it piggybacks on the same /api/v1/stores/:id endpoint that useBranding uses.
 */
function AiAutopilotChip({ storeId }: { storeId: string }) {
  const t = useT('settings');
  const [autopilot, setAutopilot] = useState<boolean | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<{ store: { theme?: Record<string, unknown> } }>(`/api/v1/stores/${storeId}`)
      .then(({ data }) => {
        if (data?.store) {
          // Default ON: undefined means ON per the aiAutopilot feature contract
          setAutopilot(data.store.theme?.aiAutopilot !== false);
        }
      })
      .catch(() => {
        // Silent — chip won't render on error
      });
  }, [storeId]);

  if (autopilot === null) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
          autopilot
            ? 'bg-primary/5 text-primary-ink border-primary/20 dark:bg-primary/10 dark:border-primary/30'
            : 'bg-muted text-muted-ink border-border'
        }`}
      >
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z" />
        </svg>
        {t('aiAutopilotChip.label')}{' '}
        <strong>{autopilot ? t('aiAutopilotChip.on') : t('aiAutopilotChip.off')}</strong>
      </span>
    </div>
  );
}

/** Discoverability status-chip: "hide from search engines" lives on the SEO page, so its state shows on the SEO card. */
function HideFromSearchChip({ storeId }: { storeId: string }) {
  const t = useT('settings');
  const [hidden, setHidden] = useState<boolean | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<{ hideFromSearchEngines?: boolean }>(`/api/v1/stores/${storeId}/seo`)
      .then(({ data }) => {
        if (data) setHidden(data.hideFromSearchEngines === true);
      })
      .catch(() => {
        // Silent: the chip does not render on error
      });
  }, [storeId]);

  if (hidden === null) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="hide-from-search-chip">
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
          hidden
            ? 'bg-warning/10 text-warning-ink border-warning/30'
            : 'bg-muted text-muted-ink border-border'
        }`}
      >
        {t('hideFromSearchChip.label')}{' '}
        <strong>{hidden ? t('hideFromSearchChip.hidden') : t('hideFromSearchChip.visible')}</strong>
      </span>
    </div>
  );
}

interface SettingsCard {
  /** Translation key under `settings.cards` (e.g. `branding`). */
  key: string;
  href: string;
  icon: React.ReactNode;
  color: string;
  /** If set, this card is only shown when the named feature is enabled. */
  featureKey?: string;
}

interface StoreBasicInfo {
  id: string;
  name: string;
  status: string;
}

export default function StoreSettingsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { isEnabled, isLoading } = useFeatures();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const t = useT('settings');
  const tCards = useT('settings.cards');
  const tCommon = useT('common');
  const { success: toastSuccess, error: toastError } = useToast();

  // Store info (plan + status) — needed for super_admin danger zone
  const [storeInfo, setStoreInfo] = useState<StoreBasicInfo | null>(null);

  // Suspend modal
  const [suspendModalOpen, setSuspendModalOpen] = useState(false);
  const [statusChanging, setStatusChanging] = useState(false);

  const fetchStore = useCallback(async () => {
    if (!isSuperAdmin || !storeId) return;
    const { data } = await apiGet<{ store: StoreBasicInfo }>(`/api/v1/admin/stores/${storeId}`);
    if (data?.store) setStoreInfo(data.store);
  }, [isSuperAdmin, storeId]);

  useEffect(() => {
    fetchStore();
  }, [fetchStore]);

  const handleStatusChange = useCallback(async () => {
    if (!storeInfo) return;
    setStatusChanging(true);
    const newStatus = storeInfo.status === 'suspended' ? 'active' : 'suspended';
    const { error: apiErr } = await apiPatch(`/api/v1/stores/${storeId}/status`, {
      status: newStatus,
    });
    if (apiErr) {
      toastError(t('superadmin.statusChangeFailed'), apiErr.message);
    } else {
      toastSuccess(
        newStatus === 'suspended' ? t('superadmin.suspended') : t('superadmin.reactivated'),
        newStatus === 'suspended'
          ? t('superadmin.suspendedBody', { name: storeInfo.name })
          : t('superadmin.reactivatedBody', { name: storeInfo.name })
      );
      await fetchStore();
    }
    setStatusChanging(false);
    setSuspendModalOpen(false);
  }, [storeInfo, storeId, fetchStore, toastSuccess, toastError, t]);

  const cards: SettingsCard[] = [
    {
      key: 'branding',
      href: `/stores/${storeId}/branding`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
          />
        </svg>
      ),
    },
    /*
     * Navigation card REMOVED 2026-06-01 (consolidation). Navigation is
     * edited in the visual editor (header content) so merchants do not
     * page-hop. The /navigation route redirects to the editor (Task 12) so
     * existing bookmarks don't 404.
     *
     * Hero / Announcement cards REMOVED 2026-05-21 (Ahmad audit). The
     * visual editor owns hero slides, announcement bar visibility + content.
     * /hero redirects to the editor (Task 12); /announcement still works by URL.
     *
     * Footer Links / pages card REMOVED 2026-06-01 (consolidation). Footer
     * link editing lives in the visual editor (footer content). The /pages
     * route redirects to the editor (Task 12).
     *
     * SEO stays in Settings since it's meta-tags + structured data, distinct
     * from the editor's typography zones.
     *
     * Announcement card RE-ADDED 2026-06-01 (P1-B nav-wire fix). The page
     * edits live content (text + colors) that merchants need to reach without
     * knowing the /announcement URL directly. Settings card is the lowest-risk
     * re-entry point matching the existing card shape; the sidebar already
     * lights up via the /announcement urlPrefix added to the Settings hub.
     */
    {
      key: 'announcement',
      href: `/stores/${storeId}/announcement`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"
          />
        </svg>
      ),
    },
    {
      key: 'categories',
      href: `/stores/${storeId}/categories`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
          />
        </svg>
      ),
    },
    {
      key: 'seo',
      href: `/stores/${storeId}/seo`,
      color: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
      featureKey: 'seo',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      ),
    },
    {
      key: 'domain',
      href: `/stores/${storeId}/domain`,
      color: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    },
    {
      key: 'paymentSettings',
      href: `/stores/${storeId}/payment-settings`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
          />
        </svg>
      ),
    },
    {
      key: 'shipping',
      href: `/stores/${storeId}/shipping`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      ),
    },
    {
      key: 'taxSettings',
      href: `/stores/${storeId}/tax`,
      color: 'bg-primary/10 text-primary-ink',
      // No featureKey (issue 2358): the tax page is reachable on every plan.
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
      ),
    },
    {
      key: 'checkoutDelivery',
      href: `/stores/${storeId}/delivery`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    },
    {
      key: 'pwaSettings',
      href: `/stores/${storeId}/pwa`,
      color: 'bg-primary/10 text-primary-ink',
      featureKey: 'pwa',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
      ),
    },
    {
      key: 'qrCodes',
      href: `/stores/${storeId}/qr`,
      color: 'bg-muted text-foreground',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm4 0h2v2h-2v-2z"
          />
        </svg>
      ),
    },
    {
      key: 'template',
      href: `/stores/${storeId}/builder`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
          />
        </svg>
      ),
    },
    {
      key: 'language',
      href: `/stores/${storeId}/language`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
          />
        </svg>
      ),
    },
    {
      // Staff-accessible page that lives in the Marketing hub (Ruling T3-1): this card is the Settings door to it.
      key: 'notifications',
      href: `/stores/${storeId}/notifications`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
      ),
    },
    /*
     * 5 cards REMOVED 2026-05-21 (Ahmad audit). Moved into the Marketing
     * hub as sibling tabs alongside AI Tools + WhatsApp:
     *   - marketingPixels  -> /stores/[id]/marketing-pixels
     *   - notifications    -> /stores/[id]/notifications
     *   - affiliates       -> /stores/[id]/affiliates
     *   - abandonedCarts   -> /stores/[id]/abandoned-carts
     *   - newsletter       -> /stores/[id]/newsletter
     *
     * shippingCarriers card also removed — it's a sub-concern of Shipping;
     * the /shipping page links to /shipping-carriers from inside.
     */
    {
      /*
       * The MCP agent write credential (Ruling M1). Feature-gated on
       * `agent_checkout` for the same reason the API route is: a merchant
       * without agentic checkout has nothing to issue a key for. Sits beside
       * WhatsApp because both are integration credentials, not marketing.
       */
      key: 'agentKey',
      href: `/stores/${storeId}/agent-key`,
      // Neutral slate, not a brand hue: `indigo` (and every other colour in
      // the eslint `no-restricted-syntax` list) is a lint warning here, and a
      // credential card reads better technical than decorative anyway.
      color: 'bg-muted text-muted-ink',
      featureKey: 'agent_checkout',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
          />
        </svg>
      ),
    },
    {
      key: 'webhooks',
      href: `/stores/${storeId}/webhooks`,
      color: 'bg-muted text-muted-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
      ),
    },
    {
      /*
       * Merchant MCP keys — the MERCHANT-ADMIN surface, not the buyer one.
       * Separate card from `agentKey` above because they are different
       * credentials for different callers: that one lets a shopping agent buy,
       * this one lets the merchant run the store. Gated on `merchant_mcp`,
       * which the plan layer turns on for Growth and Business (a
       * super-admin override wins), so the card only appears for those.
       */
      key: 'merchantKeys',
      href: `/stores/${storeId}/merchant-keys`,
      color: 'bg-muted text-muted-ink',
      featureKey: 'merchant_mcp',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 9l3 3-3 3m5 0h3M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"
          />
        </svg>
      ),
    },
    {
      // Plan, usage vs limits, upgrade (SP5 plans engine).
      key: 'billing',
      href: `/stores/${storeId}/billing`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
          />
        </svg>
      ),
    },
    {
      key: 'staff',
      href: `/stores/${storeId}/staff`,
      color: 'bg-primary/10 text-primary-ink',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
      ),
    },
  ];

  return (
    <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
      <SettingsSearch />
      <div className="space-y-8">
        <ConnectChatCard storeId={storeId} />
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className="flex items-start gap-4 rounded-xl border bg-card p-6 shadow-sm animate-pulse"
              >
                <div className="h-12 w-12 flex-shrink-0 rounded-xl bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-24 rounded bg-muted" />
                  <div className="h-3 w-full rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          SETTINGS_GROUPS.map(group => {
            const groupCards = group.items
              .map(item => cards.find(c => c.key === item.card))
              .filter((c): c is SettingsCard => !!c && (!c.featureKey || isEnabled(c.featureKey)));
            if (groupCards.length === 0) return null;
            const grid = (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {groupCards.map(card => (
                  <Link
                    data-ui="tile"
                    key={card.href}
                    href={card.href}
                    className="group flex min-h-20 items-start gap-4 rounded-xl border bg-card p-5 shadow-sm transition-all hover:border-primary hover:shadow-md"
                  >
                    <div
                      className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl ${card.color} transition-transform group-hover:scale-110`}
                    >
                      {card.icon}
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">
                        {tCards(`${card.key}.title`)}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground leading-snug">
                        {tCards(`${card.key}.description`)}
                      </p>
                      {card.key === 'branding' && <AiAutopilotChip storeId={storeId} />}
                      {card.key === 'seo' && <HideFromSearchChip storeId={storeId} />}
                    </div>
                  </Link>
                ))}
              </div>
            );
            return group.collapsed ? (
              <details key={group.key} className="group/dev">
                <summary className="mb-3 cursor-pointer select-none text-sm font-semibold text-foreground">
                  {t(`groups.${group.key}`)}
                </summary>
                {grid}
              </details>
            ) : (
              <section key={group.key} aria-labelledby={`settings-group-${group.key}`}>
                <h2
                  id={`settings-group-${group.key}`}
                  className="mb-3 text-sm font-semibold text-foreground"
                >
                  {t(`groups.${group.key}`)}
                </h2>
                {grid}
              </section>
            );
          })
        )}
      </div>

      {/* ── Super-admin: Plan info + Danger Zone ─────────────────────────── */}
      {isSuperAdmin && (
        <div className="mt-8 space-y-6">
          {/* Plan row: the subscription's priced plan + the one place to assign it (Ruling B1-PLAN-SOT-1) */}
          <SubscriptionPlanRow storeId={storeId} />

          {/* Danger Zone */}
          <div>
            <h2 className="mb-3 font-semibold text-destructive-ink">
              {t('superAdmin.dangerZoneTitle')}
            </h2>
            <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {storeInfo?.status === 'suspended'
                      ? t('superAdmin.reactivateTitle')
                      : t('superAdmin.suspendTitle')}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {storeInfo?.status === 'suspended'
                      ? t('superAdmin.reactivateDesc')
                      : t('superAdmin.suspendDesc')}
                  </p>
                </div>
                <div className="shrink-0">
                  <Button
                    variant={storeInfo?.status === 'suspended' ? 'default' : 'destructive'}
                    onClick={() => setSuspendModalOpen(true)}
                    disabled={statusChanging || !storeInfo}
                  >
                    {storeInfo?.status === 'suspended'
                      ? t('superAdmin.reactivateTitle')
                      : t('superAdmin.suspendTitle')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}

      {/* Suspend / reactivate confirm */}
      <Modal
        isOpen={suspendModalOpen}
        onClose={() => setSuspendModalOpen(false)}
        title={
          storeInfo?.status === 'suspended'
            ? t('superAdmin.reactivateTitle')
            : t('superAdmin.suspendTitle')
        }
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {storeInfo?.status === 'suspended'
            ? t('superAdmin.reactivateModalBody', { name: storeInfo?.name ?? 'this store' })
            : t('superAdmin.suspendModalBody', { name: storeInfo?.name ?? 'this store' })}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setSuspendModalOpen(false)}
            disabled={statusChanging}
          >
            {tCommon('cancel')}
          </Button>
          <Button
            variant={storeInfo?.status === 'suspended' ? 'default' : 'destructive'}
            onClick={handleStatusChange}
            disabled={statusChanging}
            isLoading={statusChanging}
          >
            {storeInfo?.status === 'suspended'
              ? t('superAdmin.reactivateButton')
              : t('superAdmin.suspendButton')}
          </Button>
        </div>
      </Modal>
      {/* A11: owner-only data export + store deletion (the section hides itself for anyone who is not the owner) */}
      <OwnerStoreLifecycle storeId={storeId} />
    </AdminLayout>
  );
}
