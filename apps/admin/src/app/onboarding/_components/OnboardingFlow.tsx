'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@force/ui';
import { useRouter } from 'next/navigation';
import { apiGet } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { StepIndicator } from './StepIndicator';
import { StoreStep } from './StoreStep';
import { TemplateStep } from './TemplateStep';
import { ProductStep } from './ProductStep';
import { PaymentStep } from './PaymentStep';
import { LiveStep } from './LiveStep';
import { VerifyGate } from './VerifyGate';
import { STEP_ORDER, type OnboardingState, type OnboardingStore, type StepKey } from './types';

/**
 * Self-serve stepper: name + address -> template -> first product -> payment
 * -> go live. State lives on the server (`GET /onboarding/state`), so a
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
  const [step, setStep] = useState<StepKey>('store');
  const [store, setStore] = useState<OnboardingStore | null>(null);
  const [productCount, setProductCount] = useState(0);

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
    if (data.store) {
      if (data.store.status === 'active') {
        routerRef.current.replace(`/stores/${data.store.id}`);
        return;
      }
      setStep(prev => (prev === 'store' ? 'template' : prev));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      {step === 'store' && store ? (
        <div className="space-y-4">
          <p className="font-medium text-foreground">{store.name}</p>
          <p dir="ltr" className="text-sm text-muted-foreground">
            {store.host}
          </p>
          <Button type="button" onClick={() => setStep('template')}>
            {t('next')}
          </Button>
        </div>
      ) : !store ? (
        <StoreStep
          onCreated={created => {
            setStore(created);
            setState(prev => (prev ? { ...prev, store: created, codEnabled: true } : prev));
            setStep('template');
          }}
        />
      ) : step === 'template' ? (
        <TemplateStep
          storeId={store.id}
          initial={store.template}
          onBack={() => setStep('store')}
          onDone={template => {
            setStore({ ...store, template });
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
        <LiveStep store={store} productCount={productCount} onBack={() => go(-1)} />
      )}
    </div>
  );
}
