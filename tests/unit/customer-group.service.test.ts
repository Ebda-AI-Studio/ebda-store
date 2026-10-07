/**
 * Customer group service — unit tests.
 *
 * Covers the invariants that are easy to get wrong and expensive to get wrong:
 * the single-default swap, the refusal to leave a store with no default,
 * cross-tenant isolation on assignment, and the P2002 → 409 translation.
 *
 * Prisma is mocked — `$transaction` is invoked with the mock client itself so
 * the service's transactional branches execute exactly as they do in
 * production, without needing a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above every top-level statement, so its factory cannot
// close over ordinary consts. vi.hoisted lifts the mocks with it.
const { mockGroup, mockCustomer } = vi.hoisted(() => ({
  mockGroup: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  mockCustomer: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
}));

vi.mock('@force/database', () => ({
  prisma: {
    customerGroup: mockGroup,
    customer: mockCustomer,
    // Run the callback against the same mocks — the service's transactional
    // branches must be exercised, not stubbed out.
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({ customerGroup: mockGroup, customer: mockCustomer }),
  },
  // #1582: assignByIdentity's create now goes through `withSavepoint`, which
  // reads `hasTenantContext` to decide whether a SAVEPOINT is needed. This
  // suite has no ambient tenant transaction (same as production outside a
  // request), so `withSavepoint` must take its pass-through branch —
  // matching `withSavepoint`'s own doc comment ("OUTSIDE a tenant context
  // this is a straight pass-through").
  hasTenantContext: () => false,
}));

import { CustomerGroupService } from '../../apps/api/src/services/customer-group.service';

const STORE = 'store-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerGroupService.create', () => {
  it('demotes the existing default when creating a new default', async () => {
    mockGroup.create.mockResolvedValue({ id: 'g2', isDefault: true });

    await CustomerGroupService.create(STORE, { name: 'VIP', isDefault: true });

    expect(mockGroup.updateMany).toHaveBeenCalledWith({
      where: { storeId: STORE, isDefault: true },
      data: { isDefault: false },
    });
  });

  it('does not touch other groups when the new group is not default', async () => {
    mockGroup.create.mockResolvedValue({ id: 'g2', isDefault: false });

    await CustomerGroupService.create(STORE, { name: 'Wholesale' });

    expect(mockGroup.updateMany).not.toHaveBeenCalled();
  });

  it('translates the unique-name violation into a 409', async () => {
    mockGroup.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(CustomerGroupService.create(STORE, { name: 'VIP' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DUPLICATE_NAME',
    });
  });
});

describe('CustomerGroupService.update', () => {
  it('refuses to unset the only default', async () => {
    mockGroup.findFirst.mockResolvedValue({ id: 'g1', isDefault: true });

    await expect(
      CustomerGroupService.update(STORE, 'g1', { isDefault: false })
    ).rejects.toMatchObject({ statusCode: 400, code: 'DEFAULT_GROUP_REQUIRED' });

    expect(mockGroup.update).not.toHaveBeenCalled();
  });

  it('demotes the previous default when promoting another group', async () => {
    mockGroup.findFirst.mockResolvedValue({ id: 'g2', isDefault: false });
    mockGroup.update.mockResolvedValue({ id: 'g2', isDefault: true });

    await CustomerGroupService.update(STORE, 'g2', { isDefault: true });

    expect(mockGroup.updateMany).toHaveBeenCalledWith({
      where: { storeId: STORE, isDefault: true },
      data: { isDefault: false },
    });
  });

  it('404s for a group belonging to another store', async () => {
    mockGroup.findFirst.mockResolvedValue(null);

    await expect(CustomerGroupService.update(STORE, 'other', { name: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('CustomerGroupService.assignCustomer', () => {
  it('404s when the group belongs to another store rather than attaching it', async () => {
    mockCustomer.findFirst.mockResolvedValue({ id: 'c1' });
    mockGroup.findFirst.mockResolvedValue(null); // cross-tenant group id

    await expect(
      CustomerGroupService.assignCustomer(STORE, 'c1', 'group-from-other-store')
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mockCustomer.update).not.toHaveBeenCalled();
  });

  it('clears the group without a group lookup when passed null', async () => {
    mockCustomer.findFirst.mockResolvedValue({ id: 'c1' });
    mockCustomer.update.mockResolvedValue({ id: 'c1', groupId: null });

    await CustomerGroupService.assignCustomer(STORE, 'c1', null);

    expect(mockGroup.findFirst).not.toHaveBeenCalled();
    expect(mockCustomer.update).toHaveBeenCalledWith({
      where: { id: 'c1', storeId: STORE },
      data: { groupId: null },
      select: { id: true, groupId: true },
    });
  });

  it('404s for a customer belonging to another store', async () => {
    mockCustomer.findFirst.mockResolvedValue(null);

    await expect(CustomerGroupService.assignCustomer(STORE, 'nope', null)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('CustomerGroupService.assignByIdentity', () => {
  it('rejects when neither phone nor email is given', async () => {
    await expect(
      CustomerGroupService.assignByIdentity(STORE, { firstName: 'A' }, 'g1')
    ).rejects.toMatchObject({ statusCode: 400, code: 'IDENTITY_REQUIRED' });

    // Bails before any group lookup or customer write.
    expect(mockGroup.findFirst).not.toHaveBeenCalled();
    expect(mockCustomer.findFirst).not.toHaveBeenCalled();
  });

  it('404s for a cross-tenant group id without touching the customer', async () => {
    mockGroup.findFirst.mockResolvedValue(null);

    await expect(
      CustomerGroupService.assignByIdentity(STORE, { phone: '+96599001234' }, 'other-store-group')
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mockCustomer.findFirst).not.toHaveBeenCalled();
    expect(mockCustomer.create).not.toHaveBeenCalled();
  });

  it('matches an existing customer by phone first and backfills contact fields', async () => {
    mockGroup.findFirst.mockResolvedValue({ id: 'g1' });
    mockCustomer.findFirst.mockResolvedValue({ id: 'c1' });
    mockCustomer.update.mockResolvedValue({ id: 'c1', groupId: 'g1', group: { id: 'g1' } });

    await CustomerGroupService.assignByIdentity(
      STORE,
      { phone: '+96599001234', email: 'a@b.com', firstName: 'Ali', lastName: 'K' },
      'g1'
    );

    expect(mockCustomer.findFirst).toHaveBeenCalledWith({
      where: { storeId: STORE, phone: '+96599001234' },
      select: { id: true },
    });
    expect(mockCustomer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1', storeId: STORE },
        data: expect.objectContaining({
          groupId: 'g1',
          phone: '+96599001234',
          email: 'a@b.com',
          firstName: 'Ali',
          lastName: 'K',
        }),
      })
    );
    expect(mockCustomer.create).not.toHaveBeenCalled();
  });

  it('falls back to a case-insensitive email match when there is no phone', async () => {
    mockGroup.findFirst.mockResolvedValue({ id: 'g1' });
    mockCustomer.findFirst.mockResolvedValue(null);
    mockCustomer.create.mockResolvedValue({ id: 'c2', groupId: 'g1', group: { id: 'g1' } });

    await CustomerGroupService.assignByIdentity(STORE, { email: 'Foo@X.com' }, 'g1');

    expect(mockCustomer.findFirst).toHaveBeenCalledWith({
      where: { storeId: STORE, email: { equals: 'Foo@X.com', mode: 'insensitive' } },
      select: { id: true },
    });
    // No existing row → materialize one, storing NULL phone (phone-less).
    expect(mockCustomer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: STORE,
          phone: null,
          email: 'Foo@X.com',
          groupId: 'g1',
        }),
      })
    );
  });

  it('recovers from a lost upsert race (P2002) by re-finding and updating', async () => {
    mockGroup.findFirst.mockResolvedValue({ id: 'g1' });
    mockCustomer.findFirst
      .mockResolvedValueOnce(null) // initial match: none
      .mockResolvedValueOnce({ id: 'c3' }); // the row the racing writer created
    mockCustomer.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    mockCustomer.update.mockResolvedValue({ id: 'c3', groupId: 'g1', group: { id: 'g1' } });

    const result = await CustomerGroupService.assignByIdentity(
      STORE,
      { phone: '+96599009999' },
      'g1'
    );

    expect(mockCustomer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c3', storeId: STORE }, data: { groupId: 'g1' } })
    );
    expect(result).toMatchObject({ id: 'c3', groupId: 'g1' });
  });
});

describe('CustomerGroupService.list', () => {
  it('flattens the prisma _count shape into customerCount', async () => {
    mockGroup.findMany.mockResolvedValue([
      { id: 'g1', name: 'VIP', isDefault: true, _count: { customers: 7 } },
    ]);

    const groups = await CustomerGroupService.list(STORE);

    expect(groups[0]).toMatchObject({ id: 'g1', customerCount: 7 });
    expect(groups[0]).not.toHaveProperty('_count');
  });
});
