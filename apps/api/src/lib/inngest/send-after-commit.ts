import { afterTenantTxCommit, hasTenantContext } from '@ebda/database';
import { deferAfterTenantCommit, hasDeferralScope } from '../after-tenant-commit';
import logger from '../logger';
import { inngest } from './client';

type Payload = Parameters<typeof inngest.send>[0];

/**
 * Send an Inngest event only once the caller's writes are COMMITTED (Rulings SEARCH-T11-12,
 * SEARCH-T11-20), so a consumer never reads rows that are not there yet or were rolled back:
 *  - inside a request: after the request transaction commits (`deferAfterTenantCommit`);
 *  - inside a `runInTenantContext` transaction elsewhere (Inngest, MCP, scripts): after THAT
 *    transaction commits (`afterTenantTxCommit`); dropped on rollback;
 *  - inside a caller transaction that cannot be hooked (`scopeTransaction` on a caller's own
 *    `$transaction`): `ifUnhookable: 'send'` sends at once (the old behaviour, for consumers with
 *    no other safety net), `'drop'` sends nothing and warns (a backstop must cover it);
 *  - with no transaction (`runInStoreScope`, plain code): every statement already committed, so it
 *    sends at once.
 * Never throws: an enqueue failure is logged with `label`.
 */
export async function sendEventAfterCommit(
  label: string,
  payload: Payload,
  opts: { ifUnhookable: 'send' | 'drop' }
): Promise<void> {
  const send = async () => {
    try {
      await inngest.send(payload);
    } catch (err) {
      logger.warn({ err, label }, `[${label}] inngest send failed`);
    }
  };
  try {
    if (hasDeferralScope()) {
      await deferAfterTenantCommit(label, send);
      return;
    }
    if (hasTenantContext()) {
      if (afterTenantTxCommit(send)) return;
      if (opts.ifUnhookable === 'send') {
        await send();
        return;
      }
      logger.warn({ label }, `[${label}] inside an unhookable transaction; not sent`);
      return;
    }
    await send();
  } catch (err) {
    logger.warn({ err, label }, `[${label}] event not sent`);
  }
}
