'use client';

/**
 * FeatureUpgradeGate — full-page upgrade-marketing card rendered when a
 * store_admin navigates to a feature-gated page they don't have access to.
 *
 * Copy sources:
 *   - Feature name + description: FEATURE_REGISTRY (bilingual, already in the
 *     registry — no per-feature hardcoding needed here).
 *   - Chrome ("Available on X", "Upgrade to X", etc.): `featureUpgrade` i18n
 *     namespace added to en.json + ar.json.
 *   - Unlocking plan: lowestPlanForFeature() from @ebda/shared.
 *   - Plan display label: publicPlanLabelForFeature() (sold plans only).
 *
 * Contact CTA:
 *   Both the primary upgrade button and the secondary "Talk to us" link point
 *   to UPGRADE_CONTACT_WHATSAPP below. Ahmad can swap the number in one place.
 */

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@ebda/ui';
import { AdminLayout } from './AdminLayout';
import {
  FEATURE_REGISTRY,
  BRAND,
  lowestPlanForFeature,
  publicPlanLabelForFeature,
  type FeatureKey,
} from '@ebda/shared';

// ─── Contact constant ─────────────────────────────────────────────────────────

/**
 * Upgrade requests go to the Ebda support mailbox (BRAND.supportEmail).
 * The message is pre-filled with the store ID and feature name.
 */

function buildUpgradeMailto(storeId: string, featureName: string): string {
  const message = `I'd like to upgrade my store (${storeId}) to unlock "${featureName}".`;
  return `mailto:${BRAND.supportEmail}?subject=${encodeURIComponent('Upgrade request')}&body=${encodeURIComponent(message)}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  featureKey: string;
  storeId: string;
  /** The screen the merchant opened, when it differs from the feature that unlocks it (e.g. AI tools need Bulk Operations). */
  pageTitle?: string;
}

export function FeatureUpgradeGate({ featureKey, storeId, pageTitle }: Props) {
  const t = useTranslations('featureUpgrade');
  const locale = useLocale();
  const isAr = locale === 'ar';

  // Resolve the feature definition from the registry. Fall back gracefully
  // if an unknown key is somehow passed (shouldn't happen in practice).
  const def = FEATURE_REGISTRY[featureKey as FeatureKey];
  const featureName = def ? (isAr ? def.nameAr : def.name) : featureKey;
  const featureDescription = def ? (isAr ? def.descriptionAr : def.description) : '';
  const featureCategory = def?.category;

  // Lowest plan that unlocks this feature.
  const unlockingPlan = def ? lowestPlanForFeature(featureKey as FeatureKey) : null;
  const publicLabel = def ? publicPlanLabelForFeature(featureKey as FeatureKey) : null;
  // Only the SOLD plans (Basic / Growth / Business) are ever named to a merchant.
  const planLabel = publicLabel ? (isAr ? publicLabel.ar : publicLabel.en) : null;
  const billingLink = `/stores/${encodeURIComponent(storeId)}/billing${
    publicLabel ? `?plan=${encodeURIComponent(publicLabel.code)}` : ''
  }#plans`;

  const upgradeLink = buildUpgradeMailto(storeId, featureName);

  // Up to 3 sibling features from the same category — same plan gate or higher —
  // shown as an "also included" list to reinforce upsell value.
  const siblings =
    def && featureCategory
      ? Object.values(FEATURE_REGISTRY)
          .filter(
            f =>
              f.key !== featureKey &&
              f.category === featureCategory &&
              !f.hidden &&
              // Only surface siblings that are unlocked by the same gate or higher.
              // This avoids showing free-tier features as "also included" bonuses.
              unlockingPlan !== null &&
              lowestPlanForFeature(f.key) !== null
          )
          .slice(0, 3)
      : [];

  // Rendered INSIDE the admin chrome (#2236): pages `return gate`, and a
  // bare card here unmounted the sidebar, hub tabs and topbar — a store_admin
  // on a gated page had no navigation left but the browser's back button.
  return (
    <AdminLayout title={pageTitle ?? featureName}>
      <div className="flex items-center justify-center min-h-[60vh] px-4 py-12">
        <div className="w-full max-w-lg">
          {/* Card */}
          <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
            {/* Brand accent strip */}
            <div className="h-1.5 w-full bg-primary" />

            <div className="p-8">
              {/* Lock badge */}
              <div className="flex items-center gap-2 mb-5">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/30 text-primary-ink px-3 py-1 text-xs font-medium">
                  {/* Lock icon */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-3.5 h-3.5 shrink-0"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {t('lockedBadge')}
                </span>
              </div>

              {/* Feature name headline */}
              <h1
                className="text-2xl font-bold tracking-tight text-foreground mb-2"
                dir={isAr ? 'rtl' : 'ltr'}
              >
                {pageTitle ?? featureName}
              </h1>
              {pageTitle && pageTitle !== featureName && (
                <p
                  className="mb-3 text-sm font-medium text-foreground/80"
                  dir={isAr ? 'rtl' : 'ltr'}
                >
                  {t('requiresFeature', { feature: featureName })}
                </p>
              )}

              {/* Feature description (value proposition) */}
              {featureDescription && (
                <p
                  className="text-base text-muted-foreground leading-relaxed mb-5"
                  dir={isAr ? 'rtl' : 'ltr'}
                >
                  {featureDescription}
                </p>
              )}

              {/* Plan availability line */}
              {planLabel && (
                <p
                  className="text-sm font-medium text-foreground/80 mb-6"
                  dir={isAr ? 'rtl' : 'ltr'}
                >
                  {t('availableOn', { plan: planLabel })}
                </p>
              )}

              {/* CTA buttons */}
              <div className="flex flex-col sm:flex-row gap-3">
                {/* Primary: upgrade (the billing page plan picker; card + InstaPay) */}
                <Link href={billingLink} className="flex-1">
                  <Button
                    type="button"
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground border-0 font-semibold"
                  >
                    {planLabel ? t('upgradeCta', { plan: planLabel }) : t('seePlansCta')}
                  </Button>
                </Link>

                {/* Secondary: talk to us */}
                <a href={upgradeLink} target="_blank" rel="noopener noreferrer" className="flex-1">
                  <Button type="button" variant="outline" className="w-full">
                    {t('contactCta')}
                  </Button>
                </a>
              </div>

              {/* Sibling features — "also included" upsell list */}
              {siblings.length > 0 && (
                <div className="mt-8 pt-6 border-t border-border">
                  <p
                    className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3"
                    dir={isAr ? 'rtl' : 'ltr'}
                  >
                    {t('alsoIncluded')}
                  </p>
                  <ul className="space-y-2">
                    {siblings.map(sibling => (
                      <li
                        key={sibling.key}
                        className="flex items-start gap-2.5"
                        dir={isAr ? 'rtl' : 'ltr'}
                      >
                        {/* Sparkle / check icon */}
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="w-4 h-4 text-primary-ink mt-0.5 shrink-0"
                          aria-hidden="true"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                            clipRule="evenodd"
                          />
                        </svg>
                        <div className="min-w-0">
                          <span className="text-sm font-medium text-foreground">
                            {isAr ? sibling.nameAr : sibling.name}
                          </span>
                          <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                            {isAr ? sibling.descriptionAr : sibling.description}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
