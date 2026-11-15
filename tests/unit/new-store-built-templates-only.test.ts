/**
 * A NEW store may only start on an Ebda template that is BUILT in the looks registry
 * (today: Qamar). The five retired Force skins (`RETIRED_TEMPLATES`) are
 * closed to new stores; existing stores keep theirs. Everything here is driven by the registry's
 * `status`, so flipping Souq / Jasmine / Lamma / Dahab to 'built' opens them with no code edit.
 * Unit only: no DB container (integration runs in CI).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  count: vi.fn(),
  findUnique: vi.fn(),
  provision: vi.fn(),
  applyLook: vi.fn(),
  storeCreate: vi.fn(),
  storeUpdate: vi.fn(),
  getById: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  runInStoreScope: async (_id: string, fn: () => unknown) => fn(),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { update: m.storeUpdate } }),
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { count: m.count },
      user: {
        findUnique: async () => ({
          email: 'o@x.com',
          firstName: 'O',
          lastName: 'A',
          storeId: null,
        }),
      },
    }),
}));
vi.mock('@api/services/billing/trial-eligibility', () => ({
  ownerHasUsedTrial: async () => false,
  markOwnerTrialUsed: async () => undefined,
}));
vi.mock('@api/lib/definer', () => ({ storeIdBySlug: m.findUnique }));
vi.mock('@api/services/provisioning.service', () => ({
  ProvisioningService: { provisionStore: m.provision },
}));
vi.mock('@api/services/store.service', () => ({
  bustStoreCaches: vi.fn(),
  StoreService: { applyLook: m.applyLook },
}));
vi.mock('@api/services/setup-guide.service', () => ({ SetupGuideService: {} }));
vi.mock('@api/lib/store-scoped-read', () => ({ readInStoreContext: vi.fn() }));
vi.mock('@api/services/plan-limit.service', () => ({ assertOwnerMayCreateStore: vi.fn() }));
vi.mock('@api/services/billing/subscription-billing.service', () => ({
  loadPayablePlan: vi.fn(async (code: string) => ({ plan: { code, isPublic: true }, price: 1 })),
  getSubscriptionBillingState: vi.fn(),
}));
vi.mock('@api/services/billing/go-live-gate', () => ({ assertStoreMayGoLive: vi.fn() }));
vi.mock('@api/services/store-creation-limit', () => ({
  assertStoreCreationBudget: vi.fn(),
  withStoreCreationLock: (_o: string, fn: () => unknown) => fn(),
}));

import {
  LOOKS,
  builtLooks,
  builtLookTemplates,
  builtSkins,
  defaultNewStoreLook,
  isBuiltSkin,
  RETIRED_TEMPLATES,
} from '@ebda/shared';
import { OnboardingService } from '@api/services/onboarding.service';
import { createStoreSchema } from '@api/routes/onboarding.schemas';

/**
 * Every look is built since Phase B5, so the "not built" cases flip ONE look back to designed for the
 * duration of the check (the registry is a plain array; the gate reads `status` at call time).
 */
async function withDesignedLook<T>(
  fn: (designed: (typeof LOOKS)[number]) => Promise<T> | T
): Promise<T> {
  const designed = LOOKS[LOOKS.length - 1]!;
  const before = designed.status;
  (designed as { status: string }).status = 'designed';
  try {
    return await fn(designed);
  } finally {
    (designed as { status: string }).status = before;
  }
}

const LEGACY = RETIRED_TEMPLATES;
const body = { name: 'Shop', slug: 'my-shop' };

beforeEach(() => {
  for (const f of [m.count, m.findUnique, m.provision, m.applyLook]) f.mockReset();
  m.count.mockResolvedValue(0);
  m.findUnique.mockResolvedValue(null);
  m.provision.mockResolvedValue({ store: { id: 'new' } });
  m.applyLook.mockResolvedValue({});
});

describe('what signup offers is the registry, not a list', () => {
  it('the offered templates and skins are exactly those with a built look', () => {
    const fromRegistry = new Set(LOOKS.filter(l => l.status === 'built').map(l => l.template));
    expect(new Set(builtLookTemplates())).toEqual(fromRegistry);
    expect(new Set(builtSkins())).toEqual(new Set(builtLooks().map(l => l.skin)));
    expect(builtLookTemplates()).toContain('qamar');
    for (const t of ['souq', 'jasmine', 'lamma', 'dahab'] as const) {
      if (!fromRegistry.has(t)) expect(builtLookTemplates()).not.toContain(t);
    }
  });

  it('no legacy Force skin is ever offered', () => {
    for (const skin of LEGACY) expect(isBuiltSkin(skin)).toBe(false);
    expect(builtSkins().some(s => (LEGACY as readonly string[]).includes(s))).toBe(false);
  });

  it('the default look is the first built look of the first built template (qamar)', () => {
    const d = defaultNewStoreLook();
    expect(d.template).toBe(builtLookTemplates()[0]);
    expect(d.template).toBe('qamar');
    expect(d.status).toBe('built');
  });
});

describe('the API refuses to CREATE a store on an old skin (Zod at the edge)', () => {
  it.each(LEGACY)('rejects template %s', skin => {
    expect(createStoreSchema.safeParse({ ...body, template: skin }).success).toBe(false);
  });
  it('accepts a built skin and a built look, and neither is required', () => {
    expect(createStoreSchema.safeParse(body).success).toBe(true);
    expect(createStoreSchema.safeParse({ ...body, template: 'qamar' }).success).toBe(true);
    expect(createStoreSchema.safeParse({ ...body, lookId: defaultNewStoreLook().id }).success).toBe(
      true
    );
  });
  it('rejects an unknown look and a look that is not built yet', async () => {
    expect(createStoreSchema.safeParse({ ...body, lookId: 'qamar.nope' }).success).toBe(false);
    await withDesignedLook(designed => {
      expect(createStoreSchema.safeParse({ ...body, lookId: designed.id }).success).toBe(false);
    });
  });
});

describe('OnboardingService.createStore (service layer, defence in depth)', () => {
  it('the provisioning default is qamar with its default look, when nothing is asked for', async () => {
    await OnboardingService.createStore({ userId: 'u1' }, body);
    expect(m.provision).toHaveBeenCalledWith(expect.objectContaining({ template: 'qamar' }));
    expect(m.applyLook).toHaveBeenCalledWith(
      'new',
      defaultNewStoreLook().id,
      { design: 'reset' },
      'u1'
    );
  });

  it.each(LEGACY)('refuses template %s before anything is created', async skin => {
    await expect(
      OnboardingService.createStore({ userId: 'u1' }, { ...body, template: skin as never })
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_AVAILABLE' });
    expect(m.provision).not.toHaveBeenCalled();
  });

  it('refuses a look that is not built before anything is created', async () => {
    await withDesignedLook(async designed => {
      await expect(
        OnboardingService.createStore({ userId: 'u1' }, { ...body, lookId: designed.id })
      ).rejects.toMatchObject({ code: 'LOOK_NOT_AVAILABLE' });
    });
    expect(m.provision).not.toHaveBeenCalled();
  });

  it('MUTATION: a look flipped to built becomes creatable with no code change; flipped back it is refused', async () => {
    const designed = LOOKS[LOOKS.length - 1]!;
    (designed as { status: string }).status = 'designed';
    expect(createStoreSchema.safeParse({ ...body, lookId: designed.id }).success).toBe(false);
    try {
      (designed as { status: string }).status = 'built';
      expect(createStoreSchema.safeParse({ ...body, lookId: designed.id }).success).toBe(true);
      await OnboardingService.createStore({ userId: 'u1' }, { ...body, lookId: designed.id });
      expect(m.provision).toHaveBeenCalledWith(
        expect.objectContaining({ template: designed.skin })
      );
    } finally {
      (designed as { status: string }).status = 'designed';
    }
    expect(createStoreSchema.safeParse({ ...body, lookId: designed.id }).success).toBe(false);
    (designed as { status: string }).status = 'built'; // restore: every look is built
  });
});
