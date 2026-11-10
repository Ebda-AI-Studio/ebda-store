/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

// 2026-11-10 P1: a brand-new merchant could sign up but not sign in. POST /auth/session answered 500 with
// `POSTGRES_REMOVED ... (user.findUnique)` from AuthService.getProfile: the Worker has no Postgres (NZ-D23) and a merchant
// with no store fell to the Prisma profile read. This walks the WHOLE first-day journey of a new merchant, in order, on the
// built Worker, with a real ES256 identity token (the accounts stub serves the matching JWKS, vitest.workers.config.mts).
// Every step must answer without reaching the removed Postgres client or an unsupported prisma-lite call.
const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  TEST_ACCOUNTS_PRIVATE_JWK: string;
  E2E_DB: string;
};

const API = 'https://api.ebda.app/api/v1';
const ADMIN_ORIGIN = 'http://localhost:3001';

const b64url = (b: ArrayBuffer | string): string => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** An identity-service access token exactly as ebda-accounts mints it (ES256, typ at+jwt, aud=store). */
async function identityToken(
  sub: string,
  email: string,
  stores: Array<{ id: string; role: string }>
) {
  const jwk = JSON.parse(e.TEST_ACCOUNTS_PRIVATE_JWK) as JsonWebKey & { kid: string };
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://accounts.ebda.app',
      aud: 'store',
      sub,
      sid: `sid-${sub}`,
      jti: crypto.randomUUID(),
      stores,
      email,
      email_verified: true,
      auth_time: now,
      iat: now,
      exp: now + 600,
    })
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

interface Step {
  name: string;
  status: number;
  body: string;
}

describe.skipIf(e.E2E_DB === '1')('new merchant journey on the Postgres-less Worker', () => {
  it('sign-up -> first sign-in -> onboarding -> catalog -> settings -> domain -> orders, no step reaches Postgres', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const [i, k] of [
      'platform_cutover.platform',
      'platform_cutover.access',
      'platform_cutover.billing',
    ].entries())
      await e.PLATFORM_DB.prepare(
        'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
      )
        .bind(`journey-marker-${i}`, k)
        .run();
    // plans are platform data (imported in production); store create and the trial plan need them
    for (const p of DEFAULT_PLAN_SEEDS)
      await e.PLATFORM_DB.prepare(
        'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 49900, 499000)'
      )
        .bind(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits))
        .run();

    const steps: Step[] = [];
    const call = async (
      name: string,
      path: string,
      init: { method?: string; token?: string; body?: unknown } = {}
    ): Promise<{ status: number; json: any }> => {
      const headers: Record<string, string> = {
        origin: ADMIN_ORIGIN,
        'cf-connecting-ip': '203.0.113.91',
      };
      if (init.token) headers.authorization = `Bearer ${init.token}`;
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const res = await e.API.fetch(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const body = await res.text();
      steps.push({ name, status: res.status, body: body.slice(0, 400) });
      console.log(
        `[journey] ${res.status} ${name}${res.status >= 400 ? ` :: ${body.slice(0, 300)}` : ''}`
      );
      let json: any = null;
      try {
        json = JSON.parse(body);
      } catch {
        // non-JSON answer: kept as text in `steps`
      }
      return { status: res.status, json };
    };

    // 1. sign-up (identity created by the accounts stub; the Store keeps no Postgres profile row)
    const email = 'journey-merchant@exit-test.invalid';
    const formToken = (await call('signup-token', '/auth/merchant/signup-token')).json?.data?.token;
    await call('signup', '/auth/merchant/signup', {
      method: 'POST',
      body: {
        email,
        password: 'Str0ng!Passw0rd-x',
        name: 'Amelia Journey',
        phone: '01012345679',
        language: 'ar',
        acceptedLegal: true,
        formToken,
      },
    });
    // 2. verify: the identity service owns the verification; its account state reports emailVerified (stub).
    const sub = '587fd55f-0000-4000-8000-00000000a001';
    let token = await identityToken(sub, email, []);

    // 3. first sign-in: no store, no profile row anywhere but the identity service
    const session = await call('auth/session (first sign-in)', '/auth/session', {
      method: 'POST',
      token,
    });
    await call('auth/me', '/auth/me', { token });

    // 4. onboarding
    await call('onboarding/state', '/onboarding/state', { token });
    await call('onboarding/slug-check', '/onboarding/slug-check?slug=amelia-journey', { token });
    const created = await call('onboarding/store (create store)', '/onboarding/store', {
      method: 'POST',
      token,
      body: { name: 'Amelia Journey', slug: 'amelia-journey', language: 'ar' },
    });
    const storeId: string = created.json?.data?.store?.id;
    expect(storeId, JSON.stringify(steps.at(-1))).toBeTruthy();
    // the identity service lists the new store in the next token (refresh after create)
    token = await identityToken(sub, email, [{ id: storeId, role: 'owner' }]);
    await call('auth/session (refresh with store)', '/auth/session', { method: 'POST', token });
    await call('stores/:id/look (choose look)', `/stores/${storeId}/look`, {
      method: 'PUT',
      token,
      body: { lookId: 'qamar.atelier', design: 'reset' },
    });
    const billing = await call('stores/:id/billing', `/stores/${storeId}/billing`, { token });
    const plan = billing.json?.data?.availablePlans?.[0];
    if (plan?.code ?? plan?.planCode)
      await call('stores/:id/billing/trial-plan', `/stores/${storeId}/billing/trial-plan`, {
        method: 'PUT',
        token,
        body: { planCode: plan.code ?? plan.planCode, interval: 'monthly' },
      });
    await call('onboarding payment-methods', `/onboarding/stores/${storeId}/payment-methods`, {
      method: 'PUT',
      token,
      body: { cod: true, instapay: { enabled: true, handle: 'amelia@instapay' } },
    });
    await call('billing/payment-method instapay', `/stores/${storeId}/billing/payment-method`, {
      method: 'POST',
      token,
      body: { method: 'instapay' },
    });
    await call('onboarding go-live', `/onboarding/stores/${storeId}/go-live`, {
      method: 'POST',
      token,
    });

    // 5. catalog
    const cat = await call('categories create', `/stores/${storeId}/categories`, {
      method: 'POST',
      token,
      body: { name: 'Dresses' },
    });
    const product = await call('products create (image)', `/stores/${storeId}/products`, {
      method: 'POST',
      token,
      body: {
        name: 'Linen dress',
        price: 125000,
        status: 'active',
        inventory: 5,
        images: [{ url: 'https://cdn.ebda.app/stores/x/dress.jpg' }],
        ...(cat.json?.data?.id ? { categoryIds: [cat.json.data.id] } : {}),
      },
    });
    let updatedVariant: { status: number; json: any } | null = null;
    const productId: string | undefined = product.json?.data?.id ?? product.json?.data?.product?.id;
    if (productId) {
      const opt = await call(
        'product option create',
        `/stores/${storeId}/products/${productId}/options`,
        {
          method: 'POST',
          token,
          body: { name: 'Size', values: [{ value: 'M' }] },
        }
      );
      const valueId: string | undefined = (opt.json?.data?.values ??
        opt.json?.data?.option?.values)?.[0]?.id;
      const variant = valueId
        ? await call('variant create', `/stores/${storeId}/products/${productId}/variants`, {
            method: 'POST',
            token,
            body: {
              price: 125000,
              inventory: 3,
              imageUrl: 'https://cdn.ebda.app/stores/x/dress-m.jpg',
              optionValueIds: [valueId],
            },
          })
        : null;
      const variantId: string | undefined = variant?.json?.data?.variant?.id;
      expect(variant?.json?.data?.variant?.inventory, 'opening variant stock').toBe(3);
      if (variantId)
        updatedVariant = await call(
          'variant update (stock)',
          `/stores/${storeId}/products/${productId}/variants/${variantId}`,
          {
            method: 'PUT',
            token,
            body: { inventory: 7 },
          }
        );
      await call('variants list', `/stores/${storeId}/products/${productId}/variants`, { token });
    }
    await call('products list', `/stores/${storeId}/products`, { token });

    // 6. settings, domain, orders
    await call('store settings GET', `/stores/${storeId}`, { token });
    await call('store settings PUT', `/stores/${storeId}`, {
      method: 'PUT',
      token,
      body: { name: 'Amelia Journey Store' },
    });
    await call('domain page', `/stores/${storeId}/domain`, { token });
    await call('orders list', `/stores/${storeId}/orders`, { token });

    const report = steps
      .map(s => `${s.status} ${s.name}${s.status >= 400 ? ` :: ${s.body}` : ''}`)
      .join('\n');
    console.log(`[merchant-journey]\n${report}`);
    const broken = steps.filter(
      s => s.status >= 500 || /POSTGRES_REMOVED|not supported/i.test(s.body)
    );
    expect(broken, report).toEqual([]);
    expect(session.json?.data?.user?.id).toBe(sub);
    expect(
      updatedVariant?.json?.data?.variant?.inventory ?? updatedVariant?.json?.data?.inventory
    ).toBe(7);
    // the core path a merchant cannot skip answers 2xx
    const core = [
      'auth/session (first sign-in)',
      'auth/me',
      'onboarding/state',
      'onboarding/store (create store)',
      'stores/:id/look (choose look)',
      'onboarding payment-methods',
      'onboarding go-live',
      'categories create',
      'products create (image)',
      'product option create',
      'variant create',
      'variant update (stock)',
      'billing/payment-method instapay',
      'store settings GET',
      'store settings PUT',
      'domain page',
      'orders list',
    ];
    for (const name of core) {
      const s = steps.find(x => x.name === name);
      expect(s && s.status < 300, `${name}\n${report}`).toBe(true);
    }
  }, 120_000);
});
