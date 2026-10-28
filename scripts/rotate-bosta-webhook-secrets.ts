/**
 * Rotate the Bosta webhook secret of every store that has Bosta configured (SEC-8 / M-132).
 *
 * Why: until SEC-8 shipped, the per-store secret in `/webhooks/shipping/bosta/:storeId/:token` was
 * written to request logs, Workers Logs and Logpush (30 days). Ebda generates this secret itself
 * (`crypto.randomBytes(24)` in carrier-connection.service.ts), so rotating it invalidates every
 * token already logged. The per-store merchant button does the same for one store
 * (`POST /stores/:id/shipping-carriers/webhook-secret/bosta/rotate`).
 *
 * Effect of a (hard) rotation: the callback URL and the derived custom header Ebda sends to Bosta
 * change. Bosta keeps the URL it was given when each delivery was created, so in-flight Bosta
 * shipments stop pushing status (their callbacks answer 401) and fall back to the tracking poller
 * (Bosta has `polling: true`); shipments created after the rotation use the new URL.
 * The SEC-8 rotation is HARD because the token is considered leaked. `--grace --reason "..."` keeps
 * the old token for in-flight shipments (<= 30 days) and is refused for a leak.
 *
 * SAFETY: DRY RUN by default; nothing is written without `--apply`. `--store <id>` scopes to one
 * store. Idempotent in the sense that a repeat run just rotates again.
 *
 *   railway run --service api -- npx tsx ../../scripts/rotate-bosta-webhook-secrets.ts            # dry run
 *   railway run --service api -- npx tsx ../../scripts/rotate-bosta-webhook-secrets.ts --apply
 */
import { fileURLToPath } from 'url';
import { prisma, runInTenantContext } from '@ebda/database';
import { shippingCarrierService } from '../apps/api/src/services/shipping-carrier.service';

export interface RotateArgs {
  apply: boolean;
  store?: string;
  grace: boolean;
  reason?: string;
}

export function parseArgs(argv: string[]): RotateArgs {
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    apply: argv.includes('--apply'),
    store: val('--store'),
    grace: argv.includes('--grace'),
    reason: val('--reason'),
  };
}

/**
 * The default is a HARD rotation: the old token stops working at once. A graceful rotation (the old
 * token keeps working for in-flight shipments, up to 30 days) needs `--grace --reason "<why>"`, and a
 * leak is never a reason: a leaked token must die immediately. Throws when the flags are unsafe.
 */
export function assertRotationMode(args: RotateArgs): void {
  if (!args.grace) return;
  const reason = (args.reason ?? '').trim();
  if (!reason || reason.startsWith('--')) {
    throw new Error('--grace needs --reason "<why a grace window is safe>"');
  }
  if (/leak|compromis|expos|stolen|breach/i.test(reason)) {
    throw new Error(
      `--grace refused: "${reason}" describes a leaked or compromised token, which must be rotated hard (no --grace)`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  assertRotationMode(args);
  const { apply, store, grace } = args;
  console.log(
    grace ? `GRACEFUL rotation (reason: ${args.reason})` : 'HARD rotation (old tokens die now)'
  );
  const stores = await prisma.store.findMany({
    where: store ? { OR: [{ id: store }, { slug: store }] } : {},
    select: { id: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });
  let rotated = 0;
  let skipped = 0;
  let failed = 0;
  for (const s of stores) {
    try {
      const has = await runInTenantContext(s.id, () =>
        prisma.shippingCarrierConfig.findFirst({
          where: { storeId: s.id, carrier: 'bosta' },
          select: { id: true },
        })
      );
      if (!has) {
        skipped++;
        continue;
      }
      if (!apply) {
        console.log(`[dry-run] would rotate the Bosta webhook secret of ${s.slug} (${s.id})`);
        rotated++;
        continue;
      }
      await runInTenantContext(s.id, () =>
        shippingCarrierService.rotateWebhookSecret(s.id, 'bosta', { grace })
      );
      console.log(`rotated ${s.slug} (${s.id})`);
      rotated++;
    } catch (err) {
      failed++;
      console.error(`FAILED ${s.slug} (${s.id}):`, err instanceof Error ? err.message : err);
    }
  }
  console.log(
    `${apply ? 'rotated' : 'would rotate'} ${rotated}; no Bosta config ${skipped}; failed ${failed}; stores ${stores.length}`
  );
  if (!apply) console.log('Dry run. Re-run with --apply to rotate.');
  await prisma.$disconnect();
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
