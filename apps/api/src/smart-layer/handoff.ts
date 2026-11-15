/** SL-HANDOFF-1: until the support channel exists, a handoff is an info alert (mirrored to the OS brain by `sendAlert`) carrying the masked transcript and the journal ids; the merchant is told support will reply on their account. */
import type { SmartLayerAdapter } from '@ebda/shared/smart-layer';
import { sendAlert } from '../services/alerts.service';

export const storeHandoff =
  (send: typeof sendAlert = sendAlert): SmartLayerAdapter['handoff'] =>
  async (ctx, p) => {
    await send({
      level: 'info',
      scope: 'store',
      store: { id: ctx.storeId, name: ctx.storeId },
      source: 'assistant.handoff',
      title: `Assistant handoff: ${p.reason}`,
      // Ids and sizes only: the masked transcript is already in `sl_turns` (90 days, erased with the customer), and masking does not remove a name, so it never goes to a log or a chat.
      body: `${p.reason}: ${p.journalIds.length} journal id(s), ${p.maskedTranscript.length} characters of transcript in the journal`,
      context: { storeId: ctx.storeId, reason: p.reason, journalIds: p.journalIds },
    });
  };
