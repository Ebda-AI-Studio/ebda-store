'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useRouter } from 'next/navigation';
import { apiGet } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { StepIndicator } from './StepIndicator';
import { PlanStep } from './PlanStep';
import { DEFAULT_SELECTION, STATIC_PLANS } from '../../../components/billing/plans';
import { StoreStep } from './StoreStep';
import { BillingStep } from './BillingStep';
import { TemplateStep } from './TemplateStep';
import { ProductStep } from './ProductStep';
import { PaymentStep } from './PaymentStep';
import { LiveStep } from './LiveStep';
import { VerifyGate } from './VerifyGate';
import {
  isTrialPlanCode,
  readStoredPlan,
  type BillingInfo,
  type PlanOption,
  type PlanSelection,
} from '../../../components/billing/types';
import { STEP_ORDER, type OnboardingState, type OnboardingStore, type StepKey } from './types';

/**
 * Self-serve stepper: plan -> name + address -> how you will pay -> template
 * -> first product -> payment -> go live. State lives on the server (`GET /onboarding/state`), so a
 * refresh or a return visit resumes at the first unfinished point; an already
 * live store goes straight to its dashboard.
 */
export function OnboardingFlow() {
  const t = useT('onboarding.flow');
  const router = useRouter();
  // `load` must not change identity when the router object does, or the
  // effect below would refetch (and reset the stepper) on every render.
  const routerRef = useRef(router);
  routerRef.current = router;
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState<StepKey>('plan');
  const [store, setStore] = useState<OnboardingStore | null>(null);
  const [lookFailed, setLookFailed] = useState(false);
  const [productCount, setProductCount] = useState(0);
  const [plan, setPlan] = useState<PlanSelection>(DEFAULT_SELECTION);
  const [plans, setPlans] = useState<PlanOption[]>(STATIC_PLANS);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const { data, error } = await apiGet<OnboardingState>('/api/v1/onboarding/state');
    if (error || !data) {
      setLoadFailed(true);
      return;
    }
    setState(data);
    setStore(data.store);
    setProductCount(data.productCount);
    // Preselect: the plan already recorded on the trial, else the one picked
    // before signup (marketing site / signup page), else Growth monthly.
    const stored = readStoredPlan();
    const recorded = data.billing?.pendingPlanCode;
    if (data.store && recorded && ['basic', 'growth', 'business'].includes(recorded)) {
      setPlan({
        planCode: recorded as PlanSelection['planCode'],
        interval: data.billing?.billingInterval ?? 'monthly',
      });
    } else if (stored) {
      setPlan(stored);
    }
    if (data.store) {
      if (data.store.status === 'active') {
        routerRef.current.replace(`/stores/${data.store.id}`);
        return;
      }
      // Resume: no way to pay on file yet -> billing; otherwise the template.
      const paid =
        !data.billing || data.billing.hasPaymentMethod || data.billing.billingMethod === 'instapay';
      setStep(prev => (prev === 'plan' ? (paid ? 'template' : 'billing') : prev));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateBilling = useCallback((billing: BillingInfo | null) => {
    setState(prev => (prev ? { ...prev, billing } : prev));
  }, []);

  const fetchBilling = useCallback(async (): Promise<BillingInfo | null> => {
    const { data } = await apiGet<OnboardingState>('/api/v1/onboarding/state');
    return data?.billing ?? null;
  }, []);

  // With a store, the API's own plan list (live prices) replaces the static catalog.
  const storeId = store?.id;
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void apiGet<{ availablePlans: PlanOption[] }>(`/api/v1/stores/${storeId}/billing`).then(
      ({ data }) => {
        const live = data?.availablePlans?.filter(p => isTrialPlanCode(p.code));
        if (!cancelled && live && live.length > 0) setPlans(live);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  const go = (delta: 1 | -1) =>
    setStep(
      prev =>
        STEP_ORDER[Math.min(STEP_ORDER.length - 1, Math.max(0, STEP_ORDER.indexOf(prev) + delta))]
    );

  if (loadFailed) {
    return (
      <div className="space-y-3 text-center">
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadFailed')}
        </p>
        <Button type="button" variant="outline" onClick={load}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (!state) {
    return (
      <p role="status" className="text-center text-sm text-muted-foreground">
        {t('loading')}
      </p>
    );
  }
  if (!state.user.emailVerified) {
    return <VerifyGate email={state.user.email} onRefresh={load} />;
  }

  return (
    <div>
      <StepIndicator current={step} />
      {step === 'plan' ? (
        <PlanStep
          plans={plans}
          initial={plan}
          storeId={store?.id}
          onDone={selection => {
            setPlan(selection);
            // The next charge (plan, amount, date) changed with the plan.
            if (store) void fetchBilling().then(b => updateBilling(b));
            setStep('store');
          }}
        />
      ) : !store ? (
        <StoreStep
          plan={plan}
          onBack={() => setStep('plan')}
          onCreated={async (created, lookApplied) => {
            setLookFailed(!lookApplied);
            const createdBilling = await fetchBilling();
            setStore(created);
            setState(prev =>
              prev ? { ...prev, store: created, codEnabled: true, billing: createdBilling } : prev
            );
            setStep('billing');
          }}
        />
      ) : step === 'store' ? (
        <div className="space-y-4">
          <p className="font-medium text-foreground">{store.name}</p>
          <p dir="ltr" className="text-sm text-muted-foreground">
            {store.host}
          </p>
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={() => setStep('plan')}>
              {t('back')}
            </Button>
            <Button type="button" onClick={() => setStep('billing')}>
              {t('next')}
            </Button>
          </div>
        </div>
      ) : step === 'billing' ? (
        <BillingStep
          storeId={store.id}
          billing={state.billing ?? null}
          plans={plans}
          onBillingChange={updateBilling}
          onBack={() => setStep('store')}
          onDone={() => setStep('template')}
        />
      ) : step === 'template' ? (
        <TemplateStep
          storeId={store.id}
          initial={store.look}
          lookFailed={lookFailed}
          onBack={() => setStep('billing')}
          onDone={look => {
            setStore({ ...store, look });
            go(1);
          }}
        />
      ) : step === 'product' ? (
        <ProductStep
          storeId={store.id}
          addedCount={productCount}
          onBack={() => go(-1)}
          onAdded={setProductCount}
          onDone={() => go(1)}
        />
      ) : step === 'payment' ? (
        <PaymentStep
          storeId={store.id}
          initialCod={state.codEnabled}
          onBack={() => go(-1)}
          onDone={() => go(1)}
        />
      ) : (
        <LiveStep
          store={store}
          productCount={productCount}
          onBack={() => go(-1)}
          onGoToBilling={() => setStep('billing')}
        />
      )}
    </div>
  );
}
