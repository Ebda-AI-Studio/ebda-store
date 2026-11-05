import { prisma } from '@ebda/database';
import type { InsightDraft } from '../lib/ci/aggregate/insights';
import { AppError } from '../middleware/error-handler';

/**
 * Persist findings. A finding already ACCEPTED or DISMISSED by a person is never rewritten; a `new` one is
 * refreshed with the latest evidence (one row per `dedupeKey`, so a daily run does not pile up copies).
 */
export async function saveInsights(
  drafts: InsightDraft[]
): Promise<{ created: number; refreshed: number }> {
  let created = 0;
  let refreshed = 0;
  for (const d of drafts) {
    const existing = await prisma.ciInsight.findUnique({
      where: { dedupeKey: d.dedupeKey },
      select: { status: true },
    });
    const asOf = new Date(`${d.evidence.asOf}T00:00:00Z`);
    if (!existing) {
      await prisma.ciInsight.create({
        data: {
          dedupeKey: d.dedupeKey,
          metric: d.metric,
          cohort: d.cohort,
          finding: d.finding,
          findingAr: d.findingAr,
          evidence: d.evidence,
          asOf,
        },
      });
      created += 1;
    } else if (existing.status === 'new') {
      await prisma.ciInsight.update({
        where: { dedupeKey: d.dedupeKey },
        data: { finding: d.finding, findingAr: d.findingAr, evidence: d.evidence, asOf },
      });
      refreshed += 1;
    }
  }
  return { created, refreshed };
}

export async function listInsights(status?: 'new' | 'accepted' | 'dismissed') {
  return prisma.ciInsight.findMany({
    where: status ? { status } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 200,
    select: {
      id: true,
      metric: true,
      cohort: true,
      finding: true,
      findingAr: true,
      evidence: true,
      model: true,
      status: true,
      asOf: true,
      decidedAt: true,
      createdAt: true,
    },
  });
}

export async function decideInsight(id: string, status: 'accepted' | 'dismissed') {
  const r = await prisma.ciInsight.updateMany({
    where: { id },
    data: { status, decidedAt: new Date() },
  });
  if (r.count === 0) throw new AppError(404, 'NOT_FOUND', 'Insight not found');
  return { id, status };
}
