// @vitest-environment jsdom
/**
 * Self-serve stepper (SP5 task 2): signup -> ... -> live. The API is mocked;
 * what is pinned is the UI contract: availability feedback (local reserved
 * check, live taken check), the request bodies each step sends (piastres, status
 * active, COD on by default), the resume rules, and the unverified gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { builtLooks } from '@ebda/shared';

const { apiGet, apiPost, apiPut, replace } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ apiGet, apiPost, apiPut }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../../../components/ImageUpload', () => ({
  ImageUpload: ({ onUpload, label }: { onUpload: (u: string) => void; label?: string }) => (
    <button type="button" onClick={() => onUpload('https://cdn.test/p.jpg')}>
      {label}
    </button>
  ),
}));
vi.mock('@/i18n/useT', () => {
  const useT = (ns?: string) => (key: string, vars?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ''}${key}${vars ? `:${JSON.stringify(vars)}` : ''}`;
  return { useT };
});

import { OnboardingFlow } from './OnboardingFlow';
import { billingFixture } from '../../../components/billing/fixtures';

const verifiedNoStore = {
  user: { email: 'mona@x.com', name: 'Mona', emailVerified: true },
  store: null,
  productCount: 0,
  codEnabled: false,
};
const inactiveStore = {
  id: 's1',
  name: 'My shop',
  slug: 'my-shop',
  status: 'inactive',
  template: 'qamar',
  look: null,
  host: 'my-shop.ebda.app',
  url: 'https://my-shop.ebda.app',
  planCode: 'free',
};

/** The picker offers only built looks and opens on the first built template: pick the first built look. */
const BUILT = builtLooks()[0]!;

function mockState(state: unknown) {
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/api/v1/onboarding/state') return { data: state, error: null };
    if (url.startsWith('/api/v1/onboarding/slug-check')) {
      const slug = new URL(url, 'http://x').searchParams.get('slug')!;
      return slug === 'taken-one'
        ? {
            data: { available: false, slug, host: `${slug}.ebda.app`, reason: 'SLUG_TAKEN' },
            error: null,
          }
        : { data: { available: true, slug, host: `${slug}.ebda.app` }, error: null };
    }
    return { data: null, error: { code: 'X', message: 'x', status: 500 } };
  });
}

// CI's jsdom has a working localStorage and some local origins have none: give
// every run the same Map-backed storage so both behave like CI.
if (
  !(() => {
    try {
      return !!window.localStorage;
    } catch {
      return false;
    }
  })()
) {
  const mem = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
  });
}

beforeEach(() => {
  // The plan step persists the choice (ebda.signup.plan); a jsdom with a real
  // localStorage (CI) would otherwise carry one test's plan into the next.
  try {
    window.localStorage?.removeItem('ebda.signup.plan');
  } catch {
    /* no storage in this environment */
  }
  apiPost.mockResolvedValue({ data: {}, error: null });
  apiPut.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Plan step -> Next -> the store step (a visitor with no store always starts at the plan). */
async function toStoreStep() {
  await screen.findByText('onboarding.flow.plan.title');
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
  return screen.findByLabelText('onboarding.flow.store.name');
}

const slugChecks = () =>
  apiGet.mock.calls.filter(c => String(c[0]).startsWith('/api/v1/onboarding/slug-check'));

describe('onboarding stepper', () => {
  it('shows the verify gate (and nothing else) for an unverified account', async () => {
    mockState({ ...verifiedNoStore, user: { ...verifiedNoStore.user, emailVerified: false } });
    render(<OnboardingFlow />);
    expect(await screen.findByText('onboarding.flow.verifyGate.title')).toBeTruthy();
    expect(screen.queryByLabelText('onboarding.flow.store.name')).toBeNull();
  });

  it('sends an already-live store to its dashboard', async () => {
    mockState({ ...verifiedNoStore, store: { ...inactiveStore, status: 'active' } });
    render(<OnboardingFlow />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/stores/s1'));
  });

  it('resumes at the template step when a store already exists', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore });
    render(<OnboardingFlow />);
    expect(await screen.findByText('onboarding.flow.template.title')).toBeTruthy();
  });

  it('resumes at billing when the store has no way to pay yet, at the template once it has one', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, billing: billingFixture() });
    render(<OnboardingFlow />);
    expect(await screen.findByText('onboarding.flow.billing.title')).toBeTruthy();
    cleanup();

    mockState({
      ...verifiedNoStore,
      store: inactiveStore,
      billing: billingFixture({ hasPaymentMethod: true, billingMethod: 'card' }),
    });
    render(<OnboardingFlow />);
    expect(await screen.findByText('onboarding.flow.template.title')).toBeTruthy();
    cleanup();

    mockState({
      ...verifiedNoStore,
      store: inactiveStore,
      billing: billingFixture({ billingMethod: 'instapay' }),
    });
    render(<OnboardingFlow />);
    expect(await screen.findByText('onboarding.flow.template.title')).toBeTruthy();
  });

  it('starts a visitor with no store at the plan step, and sends the chosen plan with the store', async () => {
    mockState(verifiedNoStore);
    apiPost.mockResolvedValueOnce({ data: { store: inactiveStore }, error: null });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.plan.title');
    fireEvent.click(screen.getByRole('radio', { name: /Business/ }));
    fireEvent.click(screen.getByRole('button', { name: /onboarding\.flow\.plan\.yearly/ }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    fireEvent.change(await screen.findByLabelText('onboarding.flow.store.name'), {
      target: { value: 'My Shop' },
    });
    const create = await screen.findByRole('button', { name: 'onboarding.flow.store.create' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2000,
    });
    fireEvent.click(create);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/onboarding/store', {
        name: 'My Shop',
        slug: 'my-shop',
        language: 'en',
        plan: { planCode: 'business', interval: 'yearly' },
      })
    );
    // Created -> how will you pay (billing is re-read from the state).
    expect(await screen.findByText('onboarding.flow.billing.title')).toBeTruthy();
  });

  it('suggests an address from the name, checks availability live, and shows <slug>.ebda.app', async () => {
    mockState(verifiedNoStore);
    render(<OnboardingFlow />);
    const name = await toStoreStep();
    fireEvent.change(name, { target: { value: 'My Shop' } });
    expect((screen.getByLabelText('onboarding.flow.store.slug') as HTMLInputElement).value).toBe(
      'my-shop'
    );
    // Debounced: nothing yet, then exactly one check for the settled value.
    expect(slugChecks()).toHaveLength(0);
    expect(
      await screen.findByText(
        'onboarding.flow.store.available:{"host":"my-shop.ebda.app"}',
        {},
        { timeout: 2000 }
      )
    ).toBeTruthy();
    expect(slugChecks()).toHaveLength(1);
    expect(
      (screen.getByRole('button', { name: 'onboarding.flow.store.create' }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it('refuses a reserved address locally, without calling the API, and blocks create', async () => {
    mockState(verifiedNoStore);
    render(<OnboardingFlow />);
    fireEvent.change(await toStoreStep(), {
      target: { value: 'Anything' },
    });
    fireEvent.change(screen.getByLabelText('onboarding.flow.store.slug'), {
      target: { value: 'app' },
    });
    expect(await screen.findByText('onboarding.flow.store.reserved')).toBeTruthy();
    await new Promise(r => setTimeout(r, 600));
    expect(slugChecks()).toHaveLength(0);
    expect(
      (screen.getByRole('button', { name: 'onboarding.flow.store.create' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it('shows "taken" from the live check and does not create', async () => {
    mockState(verifiedNoStore);
    render(<OnboardingFlow />);
    fireEvent.change(await toStoreStep(), {
      target: { value: 'Taken One' },
    });
    expect(
      await screen.findByText('onboarding.flow.store.taken', {}, { timeout: 2000 })
    ).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('creates the store (Arabic-first language from dir) and advances to billing, then the template', async () => {
    mockState(verifiedNoStore);
    apiPost.mockResolvedValueOnce({ data: { store: inactiveStore }, error: null });
    document.documentElement.dir = 'rtl';
    render(<OnboardingFlow />);
    fireEvent.change(await toStoreStep(), {
      target: { value: 'My Shop' },
    });
    const create = await screen.findByRole('button', { name: 'onboarding.flow.store.create' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2000,
    });
    fireEvent.click(create);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/onboarding/store', {
        name: 'My Shop',
        slug: 'my-shop',
        language: 'ar',
        plan: { planCode: 'growth', interval: 'monthly' },
      })
    );
    // Created -> billing step (no payment option offered by this state) -> template.
    expect(await screen.findByText('onboarding.flow.billing.title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.billing.continueAnyway' }));
    expect(await screen.findByText('onboarding.flow.template.title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await screen.findByText('onboarding.flow.product.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.skip' }));
    await screen.findByText('onboarding.flow.payment.title');
    expect(
      screen
        .getByRole('switch', { name: 'onboarding.flow.payment.cod' })
        .getAttribute('aria-checked')
    ).toBe('true');
    document.documentElement.dir = '';
  });

  it('walks template -> product -> payment -> live with the right requests', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    apiPost.mockImplementation(async (url: string) =>
      url.endsWith('/go-live')
        ? {
            data: {
              store: {
                id: 's1',
                name: 'My shop',
                host: 'my-shop.ebda.app',
                url: 'https://my-shop.ebda.app',
              },
            },
            error: null,
          }
        : { data: {}, error: null }
    );
    render(<OnboardingFlow />);

    // Look: pick a built look -> PUT /look (design reset: a brand-new store), then next.
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(BUILT.name.en) }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/look', {
        lookId: BUILT.id,
        design: 'reset',
      })
    );

    // Product: price entered in EGP is sent in piastres, active, with the photo.
    await screen.findByText('onboarding.flow.product.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.product.photo' }));
    fireEvent.change(screen.getByLabelText('onboarding.flow.product.name'), {
      target: { value: 'Scarf' },
    });
    fireEvent.change(screen.getByLabelText('onboarding.flow.product.price'), {
      target: { value: '250.50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.product.add' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/products', {
        name: 'Scarf',
        price: 25050,
        status: 'active',
        inventory: 10,
        images: [{ url: 'https://cdn.test/p.jpg' }],
      })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.flow.next' }));

    // Payment: COD on by default; the gateways are set up later in Settings > Payments.
    await screen.findByText('onboarding.flow.payment.title');
    const cod = screen.getByRole('switch', { name: 'onboarding.flow.payment.cod' });
    expect(cod.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('onboarding.flow.payment.moreLater')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/onboarding/stores/s1/payment-methods', {
        cod: true,
      })
    );

    // Live: summary then publish -> link, WhatsApp share, dashboard.
    await screen.findByText('onboarding.flow.live.title');
    // F6: the summary row names the chosen look from the registry. The useT mock renders a missing key as its path, so a
    // raw `onboarding.flow.template` (the 2026-11-02 production bug) would show up here as text starting with the namespace.
    const templateValue = screen.getByText(
      'onboarding.flow.live.checklistTemplate'
    ).nextElementSibling!;
    expect(templateValue.textContent).not.toMatch(/onboarding\./);
    expect(templateValue.textContent).toBeTruthy();
    // The #389 fix read the look from `store.template` (a skin id, never a look id) and showed a dash for every store.
    expect(templateValue.textContent).not.toBe('—');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.live.publish' }));
    expect(await screen.findByText('onboarding.flow.live.doneTitle')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledWith('/api/v1/onboarding/stores/s1/go-live');
    const wa = screen.getByRole('link', { name: /onboarding\.flow\.live\.whatsapp/ });
    expect(wa.getAttribute('href')).toContain('https://wa.me/?text=');
    expect(wa.getAttribute('href')).toContain(encodeURIComponent('https://my-shop.ebda.app'));
  });

  it('asks for a look again when the store was created but its look did not apply', async () => {
    mockState(verifiedNoStore);
    apiPost.mockResolvedValueOnce({
      data: { store: inactiveStore, lookApplied: false },
      error: null,
    });
    render(<OnboardingFlow />);
    fireEvent.change(await toStoreStep(), { target: { value: 'My Shop' } });
    const create = await screen.findByRole('button', { name: 'onboarding.flow.store.create' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2000,
    });
    fireEvent.click(create);
    await screen.findByText('onboarding.flow.billing.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.billing.continueAnyway' }));
    await screen.findByText('onboarding.flow.template.title');
    expect(screen.getByText('onboarding.flow.template.lookNotApplied')).toBeTruthy();
    // Picking a look again goes through the normal PUT /look.
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(BUILT.name.en) }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/look', {
        lookId: BUILT.id,
        design: 'reset',
      })
    );
  });

  it('shows no retry prompt when the look applied (or none was asked for)', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    expect(screen.queryByText('onboarding.flow.template.lookNotApplied')).toBeNull();
  });

  it('while saving the look the button is aria-busy with a saving label, and a thrown save does not stick', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    let rejectPut: (e: Error) => void = () => {};
    apiPut.mockImplementationOnce(() => new Promise((_, rej) => (rejectPut = rej)));
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(BUILT.name.en) }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    const busy = await screen.findByRole('button', { name: 'onboarding.flow.template.saving' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    rejectPut(new Error('network'));
    const next = await screen.findByRole('button', { name: 'onboarding.flow.next' });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe('onboarding.flow.template.saveFailed');
  });

  it('continuing without picking a look saves nothing (the store keeps its default)', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await screen.findByText('onboarding.flow.product.title');
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('blocks Continue when COD is switched off (a store needs one payment method)', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.flow.skip' }));
    await screen.findByText('onboarding.flow.payment.title');
    fireEvent.click(screen.getByRole('switch', { name: 'onboarding.flow.payment.cod' }));
    expect(
      (screen.getByRole('button', { name: 'onboarding.flow.next' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getAllByText('onboarding.flow.payment.needOne').length).toBeGreaterThan(0);
  });

  it('enables InstaPay with its handle during onboarding (FIX-006)', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.flow.skip' }));
    await screen.findByText('onboarding.flow.payment.title');
    const next = () =>
      screen.getByRole('button', { name: 'onboarding.flow.next' }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole('switch', { name: 'onboarding.flow.payment.instapay' }));
    // On with no handle/phone: blocked, with the reason shown.
    expect(next().disabled).toBe(true);
    expect(screen.getByText('onboarding.flow.payment.needHandleOrPhone')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('onboarding.flow.payment.handleLabel'), {
      target: { value: ' amelia@instapay ' },
    });
    expect(next().disabled).toBe(false);
    fireEvent.click(next());
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/onboarding/stores/s1/payment-methods', {
        cod: true,
        instapay: { enabled: true, handle: 'amelia@instapay' },
      })
    );
  });

  it('allows InstaPay alone (COD off) once InstaPay has a handle', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.flow.skip' }));
    await screen.findByText('onboarding.flow.payment.title');
    fireEvent.click(screen.getByRole('switch', { name: 'onboarding.flow.payment.cod' }));
    fireEvent.click(screen.getByRole('switch', { name: 'onboarding.flow.payment.instapay' }));
    fireEvent.change(screen.getByLabelText('onboarding.flow.payment.phoneLabel'), {
      target: { value: '01012345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/onboarding/stores/s1/payment-methods', {
        cod: false,
        instapay: { enabled: true, phone: '01012345678' },
      })
    );
  });

  it('shows the localized go-live refusal and links back to the billing step', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore, codEnabled: true });
    apiPost.mockImplementation(async (url: string) =>
      url.endsWith('/go-live')
        ? {
            data: null,
            error: {
              code: 'PAYMENT_METHOD_REQUIRED',
              message: 'Add a payment method first',
              status: 402,
            },
          }
        : { data: {}, error: null }
    );
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.flow.skip' }));
    await screen.findByText('onboarding.flow.payment.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await screen.findByText('onboarding.flow.live.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.live.publish' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Add a payment method first');
    expect(alert.textContent).not.toContain('publishFailed');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.live.addPayment' }));
    expect(await screen.findByText('onboarding.flow.billing.title')).toBeTruthy();
  });

  it('rejects a non-positive price before calling the API', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await screen.findByText('onboarding.flow.product.title');
    fireEvent.change(screen.getByLabelText('onboarding.flow.product.name'), {
      target: { value: 'Free thing' },
    });
    fireEvent.change(screen.getByLabelText('onboarding.flow.product.price'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.product.add' }));
    expect(await screen.findByText('onboarding.flow.product.priceInvalid')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('onboarding error and navigation regressions', () => {
  it('returns to the created store without offering a second creation', async () => {
    mockState({ ...verifiedNoStore, store: inactiveStore });
    render(<OnboardingFlow />);
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.back' }));
    await screen.findByText('onboarding.flow.billing.title');
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.back' }));
    expect(await screen.findByText('My shop')).toBeTruthy();
    expect(screen.queryByLabelText('onboarding.flow.store.name')).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    expect(await screen.findByText('onboarding.flow.billing.title')).toBeTruthy();
  });
  it('does not claim a failed verification resend succeeded', async () => {
    mockState({ ...verifiedNoStore, user: { ...verifiedNoStore.user, emailVerified: false } });
    apiPost.mockResolvedValue({ data: null, error: { status: 429, code: 'RATE_LIMITED' } });
    render(<OnboardingFlow />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'onboarding.flow.verifyGate.resend' })
    );
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'onboarding.flow.verifyGate.rateLimited'
    );
    expect(screen.queryByText('onboarding.flow.verifyGate.resent')).toBeNull();
  });
});
