// @vitest-environment jsdom
/**
 * Self-serve stepper (SP5 task 2): signup -> ... -> live. The API is mocked;
 * what is pinned is the UI contract: availability feedback (local reserved
 * check, live taken check), the request bodies each step sends (piastres, status
 * active, COD on by default), the resume rules, and the unverified gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost, apiPut, replace } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('../../../lib/api', () => ({ apiGet, apiPost, apiPut }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
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
  template: 'modern',
  host: 'my-shop.ebda.app',
  url: 'https://my-shop.ebda.app',
  planCode: 'free',
};

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

beforeEach(() => {
  apiPost.mockResolvedValue({ data: {}, error: null });
  apiPut.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

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

  it('suggests an address from the name, checks availability live, and shows <slug>.ebda.app', async () => {
    mockState(verifiedNoStore);
    render(<OnboardingFlow />);
    const name = await screen.findByLabelText('onboarding.flow.store.name');
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
    fireEvent.change(await screen.findByLabelText('onboarding.flow.store.name'), {
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
    fireEvent.change(await screen.findByLabelText('onboarding.flow.store.name'), {
      target: { value: 'Taken One' },
    });
    expect(
      await screen.findByText('onboarding.flow.store.taken', {}, { timeout: 2000 })
    ).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('creates the store (Arabic-first language from dir) and advances to the template step', async () => {
    mockState(verifiedNoStore);
    apiPost.mockResolvedValueOnce({ data: { store: inactiveStore }, error: null });
    document.documentElement.dir = 'rtl';
    render(<OnboardingFlow />);
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
        language: 'ar',
      })
    );
    expect(await screen.findByText('onboarding.flow.template.title')).toBeTruthy();
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

    // Template: pick "elegant" -> PUT, then next.
    await screen.findByText('onboarding.flow.template.title');
    fireEvent.click(screen.getByRole('radio', { name: /^onboarding\.flow\.template\.elegant/ }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/template', { template: 'elegant' })
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
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.live.publish' }));
    expect(await screen.findByText('onboarding.flow.live.doneTitle')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledWith('/api/v1/onboarding/stores/s1/go-live');
    const wa = screen.getByRole('link', { name: /onboarding\.flow\.live\.whatsapp/ });
    expect(wa.getAttribute('href')).toContain('https://wa.me/?text=');
    expect(wa.getAttribute('href')).toContain(encodeURIComponent('https://my-shop.ebda.app'));
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
