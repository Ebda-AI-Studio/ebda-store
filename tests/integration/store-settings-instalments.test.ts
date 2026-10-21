/**
 * Ruling B2-9, isolation: store A's instalment settings never render on store B, and the public
 * settings projection carries `instalments` for the store that set it only. Real Postgres,
 * owner-role fixtures.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { publicStoreSettings } from '../../apps/api/src/lib/public-store-settings';
import { resolveInstalment } from '@ebda/shared';

const OWNER_ID = '00000000-0000-0000-0000-0000000b2509';
let a: { id: string; settings: unknown };
let b: { id: string; settings: unknown };

describe.skipIf(!hasDb)('settings.instalments tenant isolation', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: OWNER_ID },
      update: {},
      create: {
        id: OWNER_ID,
        email: `inst-owner-${Date.now()}@example.test`,
        passwordHash: 'x',
        firstName: 'In',
        lastName: 'Stalment',
      },
    });
    const mk = async (label: string, settings: object) => {
      const slug = `inst-${label}-${randomUUID().slice(0, 8)}`;
      return prisma.store.create({
        data: { name: slug, slug, ownerId: OWNER_ID, settings },
        select: { id: true, settings: true },
      });
    };
    a = await mk('a', { instalments: { enabled: true, months: 12, markupPct: 0 } });
    b = await mk('b', { deliveryDays: { min: 1, max: 2 } });
  });

  it('store A resolves a line, store B (no setting) resolves nothing', async () => {
    const [sa, sb] = await Promise.all([
      prisma.store.findUniqueOrThrow({ where: { id: a.id }, select: { settings: true } }),
      prisma.store.findUniqueOrThrow({ where: { id: b.id }, select: { settings: true } }),
    ]);
    const instA = (publicStoreSettings(sa.settings) as { instalments?: unknown }).instalments;
    const instB = (publicStoreSettings(sb.settings) as { instalments?: unknown }).instalments;
    expect(resolveInstalment(instA, 1_200_000, true)).toMatchObject({
      months: 12,
      monthly: 100_000,
    });
    expect(instB).toBeUndefined();
    expect(resolveInstalment(instB, 1_200_000, true)).toBeNull();
  });

  it('the merge is shallow and per store: clearing A leaves B untouched, null reads as unset', async () => {
    await prisma.store.update({
      where: { id: a.id },
      data: { settings: { instalments: null } },
    });
    const sa = await prisma.store.findUniqueOrThrow({
      where: { id: a.id },
      select: { settings: true },
    });
    expect(
      resolveInstalment((sa.settings as Record<string, unknown>).instalments, 1_200_000, true)
    ).toBeNull();
    const sb = await prisma.store.findUniqueOrThrow({
      where: { id: b.id },
      select: { settings: true },
    });
    expect(sb.settings).toEqual({ deliveryDays: { min: 1, max: 2 } });
  });
});
