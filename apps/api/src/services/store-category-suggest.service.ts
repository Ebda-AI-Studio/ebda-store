/**
 * AI category suggestions for a store that has NO categories yet, derived from its products
 * (docs/plans/ai-features.md Feature 3, the "no categories exist yet" case).
 *
 * `proposeStoreCategories` asks the model for a grouping and returns it as a PROPOSAL; nothing is written. The
 * merchant accepts or edits it in the admin, and `applyStoreCategories` creates what they approved. The model sees
 * product names, Arabic names and a clipped description, nothing else (no customers, orders or reviews); the product
 * text is merchant data and travels as a JSON string value, never as instructions (AIService owns the prompt).
 * Every id the model returns is checked against the products we actually showed it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import { storeWriter } from '../lib/repo-factory';
import { prisma } from '@ebda/database';
import { AIService } from './ai.service';
import { invalidateCached } from '../lib/public-cache';
import { auditLog } from '../middleware/security';

export const MAX_SAMPLE_PRODUCTS = 60;
export const MAX_PROPOSED_CATEGORIES = 8;
const DESCRIPTION_CLIP = 160;

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

export interface StoreCategoryProposal {
  categories: Array<{
    name: string;
    nameAr: string;
    products: Array<{ id: string; name: string; nameAr: string | null }>;
  }>;
  /** Products in the sample that no proposed category holds. */
  unassigned: number;
  sampled: number;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

export async function proposeStoreCategories(
  storeId: string
): Promise<Result<StoreCategoryProposal>> {
  const existing = await prisma.category.count({ where: { storeId, deletedAt: null } });
  if (existing > 0)
    return {
      ok: false,
      status: 409,
      code: 'CATEGORIES_EXIST',
      message: 'Suggestions are only offered while the store has no categories.',
    };
  const products = await prisma.product.findMany({
    where: { storeId, deletedAt: null, status: { not: 'archived' } },
    select: { id: true, name: true, nameAr: true, description: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_SAMPLE_PRODUCTS,
  });
  if (products.length === 0)
    return {
      ok: false,
      status: 409,
      code: 'NO_PRODUCTS',
      message: 'Add some products first; the suggestion is built from them.',
    };

  const sample = products.map(p => ({
    id: p.id,
    name: p.name,
    nameAr: p.nameAr ?? null,
    description: (p.description ?? '').slice(0, DESCRIPTION_CLIP),
  }));
  const byId = new Map(sample.map(p => [p.id, p]));
  const out = await AIService.proposeStoreCategories({ storeId, products: sample });

  const taken = new Set<string>();
  const seenNames = new Set<string>();
  const categories: StoreCategoryProposal['categories'] = [];
  for (const c of out.categories) {
    const name = norm(c.name);
    if (!name || seenNames.has(name.toLowerCase())) continue;
    const items = c.productIds
      .filter(id => byId.has(id) && !taken.has(id))
      .map(id => ({ id, name: byId.get(id)!.name, nameAr: byId.get(id)!.nameAr }));
    if (items.length === 0) continue;
    items.forEach(p => taken.add(p.id));
    seenNames.add(name.toLowerCase());
    categories.push({ name, nameAr: norm(c.nameAr ?? ''), products: items });
    if (categories.length >= MAX_PROPOSED_CATEGORIES) break;
  }
  return {
    ok: true,
    value: { categories, unassigned: sample.length - taken.size, sampled: sample.length },
  };
}

export const applyStoreCategoriesSchema = z
  .object({
    categories: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            nameAr: z.string().trim().max(60).default(''),
            productIds: z.array(z.string().uuid()).max(200),
          })
          .strict()
      )
      .min(1)
      .max(MAX_PROPOSED_CATEGORIES),
  })
  .strict();

function baseSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return s || `category-${Date.now()}`;
}

export async function applyStoreCategories(args: {
  storeId: string;
  userId: string;
  categories: unknown;
}): Promise<Result<{ created: Array<{ id: string; name: string; productCount: number }> }>> {
  const parsed = applyStoreCategoriesSchema.safeParse({ categories: args.categories });
  const names = parsed.success ? parsed.data.categories.map(c => norm(c.name).toLowerCase()) : [];
  if (!parsed.success || new Set(names).size !== names.length)
    return {
      ok: false,
      status: 422,
      code: 'INVALID_CATEGORIES',
      message: 'Each category needs its own name (up to 60 characters).',
    };
  const { storeId } = args;
  const wanted = [...new Set(parsed.data.categories.flatMap(c => c.productIds))];

  // Reads first, then ONE atomic batch with category ids generated here (a DO section cannot be interactive, so a later
  // step cannot read an earlier step's generated id). Same result on Postgres and on the store's Durable Object.
  const w = await storeWriter(storeId);
  const valid = new Set(
    wanted.length
      ? (
          await w.product.findMany({
            where: { storeId, deletedAt: null, id: { in: wanted } },
            select: { id: true },
          })
        ).map(p => p.id)
      : []
  );
  const slugs = new Set(
    (
      await w.category.findMany({ where: { storeId, deletedAt: null }, select: { slug: true } })
    ).map(c => c.slug)
  );
  const made: Array<{ id: string; name: string; productCount: number }> = [];
  const ops: PromiseLike<unknown>[] = [];
  let position = 0;
  for (const c of parsed.data.categories) {
    const base = baseSlug(c.name);
    let slug = base;
    for (let n = 1; slugs.has(slug); n++) slug = `${base}-${n}`;
    slugs.add(slug);
    const id = randomUUID();
    const name = norm(c.name);
    ops.push(
      w.category.create({
        data: { id, storeId, name, nameAr: norm(c.nameAr) || null, slug, position: position++ },
      })
    );
    const ids = [...new Set(c.productIds)].filter(pid => valid.has(pid));
    if (ids.length)
      ops.push(
        w.productCategory.createMany({
          data: ids.map((productId, i) => ({ productId, categoryId: id, position: i })),
          skipDuplicates: true,
        })
      );
    made.push({ id, name, productCount: ids.length });
  }
  await w.$transaction(ops as never);
  const created = made;

  await invalidateCached(`public:categories:${storeId}`);
  await auditLog({
    action: 'category.created_from_ai_suggestion',
    userId: args.userId,
    resourceType: 'store',
    resourceId: storeId,
    details: { categories: created.length },
  });
  return { ok: true, value: { created } };
}
