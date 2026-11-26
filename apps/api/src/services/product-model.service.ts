/**
 * Product 3D models — DB side. Routes: routes/product-model.routes.ts.
 * Design: docs/plans/2026-10-07-product-3d-viewer.md.
 *
 * Every function here runs inside the caller's tenant context (request
 * transaction or `runInTenantContext`); both tables are under strict RLS, so a
 * call without one reads nothing and writes nothing.
 */
import { Prisma } from '@ebda/database';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { atomicWrites } from '../lib/atomic-writes';
import type {
  Model3dBindingInput,
  Model3dMaterial,
  Model3dStats,
  PublicModel3d,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { withSavepoint } from '../lib/savepoint';

export const PUBLIC_MODEL3D_SELECT = {
  modelUrl: true,
  usdzUrl: true,
  posterUrl: true,
  altText: true,
  altTextAr: true,
  arEnabled: true,
  bindings: {
    orderBy: { createdAt: 'asc' },
    select: {
      kind: true,
      target: true,
      color: true,
      metalness: true,
      roughness: true,
      optionValue: { select: { value: true, option: { select: { name: true } } } },
    },
  },
} as const satisfies Prisma.ProductModelSelect;

/**
 * Card flag: the listing/recommendation/wishlist rows select only `model3d: { id }` and this turns
 * it into `has3d` (the relation itself never ships on a card). CACHE CLASS: BOUNDED-stale, rides
 * the listing caches; every model write calls invalidateStoreProductCaches (product-model.routes).
 * The `product_3d` entitlement is NOT applied here (cosmetic chip; the quick view and PDP read
 * the gated product, so with the feature off they show no model).
 */
export const CARD_MODEL3D_SELECT = { select: { id: true } } as const;

export function withHas3d<T extends { model3d?: unknown }>(
  row: T
): Omit<T, 'model3d'> & { has3d: boolean } {
  const { model3d, ...rest } = row;
  return { ...rest, has3d: Boolean(model3d) };
}

type PublicModelRow = Prisma.ProductModelGetPayload<{ select: typeof PUBLIC_MODEL3D_SELECT }>;

/** Storefront shape: bindings keyed by option NAME + value (what the pills know). */
export function toPublicModel3d(row: PublicModelRow | null | undefined): PublicModel3d | null {
  if (!row) return null;
  return {
    modelUrl: row.modelUrl,
    usdzUrl: row.usdzUrl,
    posterUrl: row.posterUrl,
    altText: row.altText,
    altTextAr: row.altTextAr,
    arEnabled: row.arEnabled,
    bindings: row.bindings.map(b => ({
      optionName: b.optionValue.option.name,
      value: b.optionValue.value,
      kind: b.kind === 'gltf_variant' ? 'gltf_variant' : 'material',
      target: b.target,
      color: b.color,
      metalness: b.metalness,
      roughness: b.roughness,
    })),
  };
}

export const ADMIN_MODEL3D_SELECT = {
  id: true,
  productId: true,
  modelUrl: true,
  modelBytes: true,
  usdzUrl: true,
  usdzBytes: true,
  posterUrl: true,
  altText: true,
  altTextAr: true,
  arEnabled: true,
  materials: true,
  gltfVariants: true,
  stats: true,
  createdAt: true,
  updatedAt: true,
  bindings: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      optionValueId: true,
      kind: true,
      target: true,
      color: true,
      metalness: true,
      roughness: true,
    },
  },
} as const satisfies Prisma.ProductModelSelect;

/** The live (not soft-deleted) product, or a 404. */
export async function assertProductInStore(storeId: string, productId: string) {
  const product = await (
    await storeDb(storeId)
  ).product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    select: { id: true },
  });
  if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  return product;
}

export async function getAdminModel(storeId: string, productId: string) {
  await assertProductInStore(storeId, productId);
  const [model, options] = await Promise.all([
    (await storeDb(storeId)).productModel.findFirst({
      where: { storeId, productId },
      select: ADMIN_MODEL3D_SELECT,
    }),
    (await storeDb(storeId)).productOption.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        name: true,
        nameAr: true,
        values: {
          orderBy: { position: 'asc' },
          select: { id: true, value: true, valueAr: true },
        },
      },
    }),
  ]);
  return { model, options };
}

function names(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json
    .map(x =>
      typeof x === 'string'
        ? x
        : x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string'
          ? (x as { name: string }).name
          : ''
    )
    .filter(Boolean);
}

/**
 * Create or replace the model of a product. On replace, bindings whose target
 * (material / glTF variant) does not exist in the NEW file are deleted and
 * counted — never left pointing at nothing. Returns the previous URLs so the
 * caller can clean the replaced R2 objects after COMMIT.
 */
export async function upsertModel(
  storeId: string,
  productId: string,
  input: {
    modelUrl: string;
    modelBytes: number;
    materials: Model3dMaterial[];
    gltfVariants: string[];
    stats: Model3dStats;
  }
): Promise<{ previousModelUrl: string | null; droppedBindings: number }> {
  await assertProductInStore(storeId, productId);
  const existing = await (
    await storeDb(storeId)
  ).productModel.findFirst({
    where: { storeId, productId },
    select: { id: true, modelUrl: true },
  });
  const data = {
    modelUrl: input.modelUrl,
    modelBytes: input.modelBytes,
    materials: input.materials as unknown as Prisma.InputJsonValue,
    gltfVariants: input.gltfVariants as unknown as Prisma.InputJsonValue,
    stats: input.stats as unknown as Prisma.InputJsonValue,
  };
  if (!existing) {
    // Two concurrent first uploads race on UNIQUE(product_id). The savepoint
    // keeps the request transaction alive when ours loses (CLAUDE.md RLS note);
    // the loser then takes the replace path below against the winner's row.
    try {
      const w = await storeWriter(storeId);
      await withSavepoint(() => w.productModel.create({ data: { storeId, productId, ...data } }));
      return { previousModelUrl: null, droppedBindings: 0 };
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      return upsertModel(storeId, productId, input);
    }
  }
  const w = await storeWriter(storeId);
  const materialNames = input.materials.map(m => m.name);
  // one atomic batch: the replaced file and the dropped bindings land together
  const [, dropped] = await atomicWrites(storeId, w, [
    w.productModel.update({ where: { id: existing.id, storeId }, data }),
    w.productModelBinding.deleteMany({
      where: {
        storeId,
        modelId: existing.id,
        OR: [
          { kind: 'material', target: { notIn: materialNames } },
          { kind: 'gltf_variant', target: { notIn: input.gltfVariants } },
        ],
      },
    }),
  ]);
  return { previousModelUrl: existing.modelUrl, droppedBindings: dropped.count };
}

export async function setUsdz(
  storeId: string,
  productId: string,
  usdzUrl: string,
  usdzBytes: number
): Promise<{ previousUsdzUrl: string | null }> {
  const existing = await (
    await storeDb(storeId)
  ).productModel.findFirst({
    where: { storeId, productId },
    select: { id: true, usdzUrl: true },
  });
  if (!existing) throw new AppError(404, 'NO_MODEL', 'Upload the .glb model first');
  await (
    await storeWriter(storeId)
  ).productModel.update({
    where: { id: existing.id, storeId },
    data: { usdzUrl, usdzBytes },
  });
  return { previousUsdzUrl: existing.usdzUrl };
}

export async function getModelRow(storeId: string, productId: string) {
  const model = await (
    await storeDb(storeId)
  ).productModel.findFirst({
    where: { storeId, productId },
    select: {
      id: true,
      modelUrl: true,
      usdzUrl: true,
      posterUrl: true,
      materials: true,
      gltfVariants: true,
    },
  });
  if (!model) throw new AppError(404, 'NO_MODEL', 'This product has no 3D model');
  return model;
}

/**
 * Replace the whole binding set. Every option value must belong to THIS
 * product, and every target must exist in the uploaded file — a binding the
 * viewer cannot apply is refused, not stored.
 */
export async function replaceBindings(
  storeId: string,
  productId: string,
  bindings: Model3dBindingInput[]
): Promise<number> {
  const model = await getModelRow(storeId, productId);
  const values = await (
    await storeDb(storeId)
  ).productOptionValue.findMany({
    where: { option: { productId } },
    select: { id: true },
  });
  const valueIds = new Set(values.map(v => v.id));
  const materials = new Set(names(model.materials));
  const variants = new Set(names(model.gltfVariants));
  for (const b of bindings) {
    if (!valueIds.has(b.optionValueId)) {
      throw new AppError(
        400,
        'INVALID_OPTION_VALUE',
        'Option value does not belong to this product'
      );
    }
    const known = b.kind === 'material' ? materials : variants;
    if (!known.has(b.target)) {
      throw new AppError(400, 'UNKNOWN_TARGET', `"${b.target}" is not in the 3D model`);
    }
  }
  const w = await storeWriter(storeId);
  await atomicWrites(storeId, w, [
    w.productModelBinding.deleteMany({ where: { storeId, modelId: model.id } }),
    ...(bindings.length > 0
      ? [
          w.productModelBinding.createMany({
            data: bindings.map(b => ({
              storeId,
              modelId: model.id,
              optionValueId: b.optionValueId,
              kind: b.kind,
              target: b.target,
              color: b.kind === 'material' ? (b.color ?? null) : null,
              metalness: b.kind === 'material' ? (b.metalness ?? null) : null,
              roughness: b.kind === 'material' ? (b.roughness ?? null) : null,
            })),
          }),
        ]
      : []),
  ]);
  return bindings.length;
}
