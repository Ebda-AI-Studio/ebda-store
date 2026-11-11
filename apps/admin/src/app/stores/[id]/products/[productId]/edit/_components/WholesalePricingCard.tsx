'use client';

/**
 * WholesalePricingCard (B2B Task 7): quantity price breaks (public or for one customer group, product-wide or for one variant),
 * the minimum order quantity and the audience (public / wholesale-only) of ONE product.
 *
 * Writers: tiers go through the price-tier API (server validates, the call also drops every pricing cache); MOQ and audience
 * go through the product update, a separate field set from the main form (the page's own save never sends them), so each field
 * has exactly one writer. Without the `b2b.wholesale` entitlement the card shows the upgrade prompt and keeps existing tiers
 * readable and deletable (a downgrade must not strand them).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { minorToDecimalString, type TierInput } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { wholesalePlanName } from '@/lib/plan-labels';
import { apiDelete, apiGet, apiPost, apiPut } from '../../../../../../../lib/api';
import { useFeatures } from '../../../../../../../hooks/useFeatures';
import { checkTierDraft, type DraftProblem } from './tier-draft';

import { Button } from '@/components/ui/Button';
interface TierRow extends TierInput {
  id: string;
  stale: boolean;
}
interface Group {
  id: string;
  name: string;
  nameAr: string | null;
}
interface Variant {
  id: string;
  title?: string | null;
  name?: string | null;
  price?: number | null;
}

interface Props {
  storeId: string;
  productId: string;
  priceMinor: number;
  costPriceMinor: number | null;
  moq: number | null;
  audience: 'public' | 'wholesale_only';
  /** The store's tax basis, for the price label ('inclusive' = prices already contain VAT). */
  vatBasis: 'inclusive' | 'exclusive' | null;
}

export function WholesalePricingCard(props: Props) {
  const { storeId, productId, priceMinor, costPriceMinor } = props;
  const t = useT('wholesale.pricing');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { isEnabled, isLoading } = useFeatures();
  const entitled = !isLoading && isEnabled('b2b.wholesale');

  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [draft, setDraft] = useState({ variantId: '', groupId: '', minQty: '', price: '' });
  const [moq, setMoq] = useState(props.moq ? String(props.moq) : '');
  const [audience, setAudience] = useState(props.audience);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const base = `/api/v1/stores/${storeId}/products/${productId}`;

  const loadTiers = useCallback(async () => {
    const { data } = await apiGet<{ tiers: TierRow[] }>(`${base}/price-tiers`);
    setTiers(data?.tiers ?? []);
  }, [base]);

  useEffect(() => {
    void loadTiers();
    void (async () => {
      const g = await apiGet<{ groups: Group[] }>(`/api/v1/stores/${storeId}/customer-groups`);
      setGroups(g.data?.groups ?? []);
      const v = await apiGet<{ variants: Variant[] }>(`${base}/variants`);
      setVariants(v.data?.variants ?? []);
    })();
  }, [base, storeId, loadTiers]);

  const variantPrice = variants.find(v => v.id === draft.variantId)?.price ?? null;
  const check = useMemo(
    () =>
      checkTierDraft(
        {
          variantId: draft.variantId || null,
          groupId: draft.groupId || null,
          minQty: draft.minQty,
          price: draft.price,
        },
        {
          existing: tiers,
          productPriceMinor: priceMinor,
          variantPriceMinor: variantPrice,
          costPriceMinor,
          moq: moq ? Number(moq) : null,
        }
      ),
    [draft, tiers, priceMinor, variantPrice, costPriceMinor, moq]
  );

  const problemText = (p: DraftProblem) =>
    p === 'MIN_QTY' ? t('problem.minQty') : p === 'PRICE' ? t('problem.price') : t(`problem.${p}`);

  const addTier = async () => {
    if (!check.tier || check.problem) return;
    setBusy(true);
    setMessage(null);
    const { data, error } = await apiPost<{ warnings?: Array<{ code: string }> }>(
      `${base}/price-tiers`,
      {
        variantId: check.tier.variantId,
        groupId: check.tier.groupId,
        minQty: check.tier.minQty,
        priceMinor: check.tier.priceMinor,
      }
    );
    setBusy(false);
    if (error) {
      // The server is the authority: show ITS verdict (an error code we know, else its message).
      const known = [
        'TIER_ABOVE_BASE',
        'TIER_NOT_MONOTONE',
        'TIER_VARIANT_ABOVE_PRODUCT',
        'TIER_DUPLICATE',
        'TIER_LIMIT',
      ];
      setMessage({
        kind: 'error',
        text: known.includes(error.code) ? t(`problem.${error.code}`) : error.message,
      });
      return;
    }
    const w = (data?.warnings ?? []).map(x => t(`warning.${x.code}`));
    setMessage({ kind: 'ok', text: [t('tierAdded'), ...w].join(' ') });
    setDraft({ ...draft, minQty: '', price: '' });
    await loadTiers();
  };

  const removeTier = async (id: string) => {
    setBusy(true);
    const { error } = await apiDelete(`${base}/price-tiers/${id}`);
    setBusy(false);
    if (error) setMessage({ kind: 'error', text: error.message });
    else await loadTiers();
  };

  const saveRules = async () => {
    setBusy(true);
    setMessage(null);
    const moqNum = moq.trim() === '' ? null : Number(moq);
    if (moqNum !== null && (!Number.isInteger(moqNum) || moqNum < 2)) {
      setBusy(false);
      setMessage({ kind: 'error', text: t('problem.moq') });
      return;
    }
    const { error } = await apiPut(`/api/v1/stores/${storeId}/products/${productId}`, {
      moq: moqNum,
      audience,
    });
    setBusy(false);
    setMessage(
      error ? { kind: 'error', text: error.message } : { kind: 'ok', text: t('rulesSaved') }
    );
  };

  const scopeLabel = (r: TierRow) => {
    const g = r.groupId ? groups.find(x => x.id === r.groupId) : null;
    const v = r.variantId ? variants.find(x => x.id === r.variantId) : null;
    return [
      g ? g.name : t('everyone'),
      v ? (v.title ?? v.name ?? t('variant')) : t('allVariants'),
    ].join(' / ');
  };

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm" data-testid="wholesale-pricing-card">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('hint')}{' '}
          {props.vatBasis
            ? t(props.vatBasis === 'inclusive' ? 'vatInclusive' : 'vatExclusive')
            : null}
        </p>
      </div>

      {!entitled && !isLoading ? (
        <div role="note" className="mb-4 rounded-md border bg-muted px-3 py-2 text-sm">
          {t('upgrade', { plan: wholesalePlanName(locale) })}{' '}
          <Link href={`/stores/${storeId}/billing`} className="font-medium text-primary underline">
            {t('upgradeLink')}
          </Link>
        </div>
      ) : null}

      {message ? (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={
            'mb-3 text-sm ' +
            (message.kind === 'error' ? 'text-destructive-ink' : 'text-foreground')
          }
        >
          {message.text}
        </p>
      ) : null}

      {tiers.length > 0 ? (
        <table className="mb-4 w-full text-start text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="py-1 text-start font-normal">{t('scope')}</th>
              <th className="py-1 text-start font-normal">{t('minQty')}</th>
              <th className="py-1 text-start font-normal">{t('unitPrice')}</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {tiers.map(r => (
              <tr key={r.id} className="border-t">
                <td className="py-2">
                  <bdi>{scopeLabel(r)}</bdi>
                  {r.stale ? (
                    <span className="ms-2 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning-ink">
                      {t('stale')}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 tabular-nums">{r.minQty}+</td>
                <td className="py-2 tabular-nums">{minorToDecimalString(r.priceMinor)}</td>
                <td className="py-2 text-end">
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeTier(r.id)}
                    variant="link"
                    className="text-destructive-ink"
                  >
                    {t('remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">{t('empty')}</p>
      )}

      {entitled ? (
        <fieldset className="mb-4 grid gap-3 sm:grid-cols-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium">{t('addTitle')}</legend>
          <label className="block text-sm">
            {t('audience')}
            <select
              className="mt-1 min-h-11 w-full rounded-md border px-3"
              value={draft.groupId}
              onChange={e => setDraft({ ...draft, groupId: e.target.value })}
            >
              <option value="">{t('everyone')}</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            {t('variantLabel')}
            <select
              className="mt-1 min-h-11 w-full rounded-md border px-3"
              value={draft.variantId}
              onChange={e => setDraft({ ...draft, variantId: e.target.value })}
            >
              <option value="">{t('allVariants')}</option>
              {variants.map(v => (
                <option key={v.id} value={v.id}>
                  {v.title ?? v.name ?? v.id}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            {t('minQty')}
            <input
              type="number"
              inputMode="numeric"
              min={2}
              className="mt-1 min-h-11 w-full rounded-md border px-3"
              value={draft.minQty}
              onChange={e => setDraft({ ...draft, minQty: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            {t('unitPrice')}
            <input
              type="text"
              inputMode="decimal"
              dir="ltr"
              className="mt-1 min-h-11 w-full rounded-md border px-3"
              value={draft.price}
              onChange={e => setDraft({ ...draft, price: e.target.value })}
            />
          </label>
          <div className="sm:col-span-2 text-xs" aria-live="polite">
            {draft.minQty !== '' || draft.price !== '' ? (
              check.problem ? (
                <span className="text-destructive-ink">{problemText(check.problem)}</span>
              ) : (
                <>
                  {check.marginPercent !== null ? (
                    <span>{t('margin', { percent: check.marginPercent })} </span>
                  ) : null}
                  {check.warnings.map(w => (
                    <span key={w} className="text-warning-ink">
                      {t(`warning.${w}`)}{' '}
                    </span>
                  ))}
                </>
              )
            ) : null}
          </div>
          <div className="sm:col-span-2">
            <Button
              type="button"
              onClick={() => void addTier()}
              disabled={busy || !check.tier || !!check.problem}
              variant="default"
            >
              {t('add')}
            </Button>
          </div>
        </fieldset>
      ) : null}

      <fieldset className="grid gap-3 border-t pt-4 sm:grid-cols-2" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">{t('rulesTitle')}</legend>
        <label className="block text-sm">
          {t('moq')}
          <input
            type="number"
            inputMode="numeric"
            min={2}
            placeholder={t('moqPlaceholder')}
            className="mt-1 min-h-11 w-full rounded-md border px-3"
            value={moq}
            onChange={e => setMoq(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t('moqHint')}</span>
        </label>
        <label className="block text-sm">
          {t('audienceField')}
          <select
            className="mt-1 min-h-11 w-full rounded-md border px-3"
            value={audience}
            onChange={e => setAudience(e.target.value as 'public' | 'wholesale_only')}
            disabled={!entitled && audience === 'public'}
          >
            <option value="public">{t('audiencePublic')}</option>
            <option value="wholesale_only">{t('audienceWholesaleOnly')}</option>
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">{t('audienceHint')}</span>
        </label>
        <div className="sm:col-span-2">
          <Button type="button" onClick={() => void saveRules()} disabled={busy} variant="outline">
            {t('saveRules')}
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
