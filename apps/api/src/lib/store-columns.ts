/**
 * Which `Store` fields live in D1 `stores` (Ruling NZ-D8): the directory columns (`d1Only`) and the mirror columns the
 * Durable Object copies. Everything else is DO-only (`store_profile` / `store_config`). A unit test pins these lists to
 * `packages/cf-schema/generated/manifest.json` `storeSplit`, so a new Prisma column cannot land silently in the wrong place.
 */
export const STORE_D1_ONLY_FIELDS = [
  'domainStatus',
  'pendingDomain',
  'domainClaimedAt',
  'domainVerifiedAt',
  'domainProvider',
  'emailSenderLocalPart',
  'emailDomainId',
  'emailDomainStatus',
  'emailDomainVerifiedAt',
  'billingSuspendedReason',
  'billingSuspendedAt',
  'deletedAt',
] as const;

export const STORE_MIRROR_FIELDS = [
  'id',
  'name',
  'nameAr',
  'slug',
  'domain',
  'ownerId',
  'status',
  'plan',
  'logo',
  'logoAr',
  'favicon',
  'currency',
  'timezone',
  'createdAt',
  'updatedAt',
  'template',
  'look',
  'isDemo',
] as const;

export const D1_FIELDS = new Set<string>([...STORE_D1_ONLY_FIELDS, ...STORE_MIRROR_FIELDS]);

/** The part of a Store patch D1 `stores` owns (authoritative there). */
export function d1StorePatch(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([k, v]) => v !== undefined && D1_FIELDS.has(k) && k !== 'id')
  );
}
