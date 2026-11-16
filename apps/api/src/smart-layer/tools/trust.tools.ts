/**
 * Self-service trust channel (SELF-SERVICE A13 / A14 / A16): the merchant writes to Ebda staff from chat. Same service calls as
 * routes/support.routes.ts and routes/onboarding.routes.ts (`createSupportRequest`, `fileAppeal`, `fileStoreCapRequest`), same caps and refusals.
 * Staff keep every decision: a tool here only FILES a request, it never lifts a suspension or a limit. Each is a confirm card because the text is sent to a person
 * and cannot be taken back (undo: irreversible, like the capability registry says).
 *   - contact_ebda_support (support.contact-ebda): topic + message, 5 per store per UTC day.
 *   - suspension_appeal (store.suspension-appeal): needs a suspended store; a billing suspension is refused (settle the invoice); one open appeal at a time.
 *   - store_limit_request (onboarding.store-cap-request): asks staff for a higher per-owner store limit, keyed on the user.
 * onboarding.slug-claim is NOT here: its proof of ownership is a document link the merchant must supply on the screen (see DEEP_LINK_ONLY).
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { SUPPORT_TOPICS, type SupportTopic } from '@ebda/shared';
import { prisma, withUser } from '@ebda/database';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';
import {
  createSupportRequest,
  fileAppeal,
  fileStoreCapRequest,
  getSuspension,
  notifyStaff,
  type TrustDb,
} from '../../services/trust-requests.service';
import { change, f, pair, row, shape } from './kit';

const OWNER = ['store_admin'] as const;
const trustDb = () => prisma as unknown as TrustDb;
const asTrustDb = (tx: unknown) => tx as TrustDb;

const contactSupport = change<{ topic: SupportTopic; message: string }>({
  name: 'contact_ebda_support',
  capabilityId: 'support.contact-ebda',
  description:
    'Send a message to the Ebda Store team (support) from inside the chat, about my store. Say: "write to Ebda Store support", "I need help from the Ebda Store team", "ابعت للدعم". Pick the closest topic. The team answers by e-mail. Max 5 messages per store per day.',
  schema: shape<{ topic: SupportTopic; message: string }>(
    {
      topic: f.enum(
        [...SUPPORT_TOPICS] as [string, ...string[]],
        'The closest topic of the request.'
      ),
      message: f.str('What the merchant needs, in their own words.', { max: 2000 }),
    },
    ['topic', 'message']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  // POST /stores/:storeId/support-requests: authorize('store_admin', 'super_admin') + requireStoreAccess
  gate: { roles: OWNER },
  audit: { action: 'support.request_created', resourceType: 'trust_request' },
  state: async () => ({ channel: 'support' }),
  describe: (_ctx, a) => ({
    summary: pair(
      `ابعت رسالة لفريق Ebda Store (${a.topic}). الرد هيجيلك على الإيميل.`,
      `Send a message to the Ebda Store team (${a.topic}). They reply by e-mail.`
    ),
    rows: [row('الموضوع', 'Topic', null, a.topic), row('الرسالة', 'Message', null, a.message)],
    affectedCount: 1,
  }),
  run: async (ctx, a) => {
    const row_ = await createSupportRequest(
      trustDb(),
      ctx.storeId,
      { userId: ctx.userId },
      { topic: a.topic, message: a.message }
    );
    void deferAfterTenantCommit('support-request.notify', async () => {
      await notifyStaff({
        subject: `Support request (${a.topic}) from store ${ctx.storeId}`,
        lines: [`Store: ${ctx.storeId}`, `Topic: ${a.topic}`, 'Via: assistant', '', a.message],
        storeId: ctx.storeId,
        ref: { requestId: row_.id, kind: 'support', topic: a.topic },
      });
    });
    return { id: row_.id };
  },
});

const suspensionAppeal = change<{ message: string }>({
  name: 'suspension_appeal',
  capabilityId: 'store.suspension-appeal',
  description:
    'Appeal my store suspension: send the Ebda Store team why the suspension should be lifted. Only works while the store is suspended for a policy reason (a billing suspension is settled by paying the invoice). One open appeal at a time; after a declined appeal wait 24 hours. Staff decide; this never reactivates the store.',
  schema: shape<{ message: string }>(
    { message: f.str("The appeal, in the merchant's own words.", { max: 1000 }) },
    ['message']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  // POST /stores/:storeId/suspension/appeal: authorize('store_admin', 'super_admin') + requireStoreAccess
  gate: { roles: OWNER },
  audit: { action: 'store.suspension_appeal', resourceType: 'trust_request' },
  state: async ctx => {
    const s = await getSuspension(trustDb(), ctx.storeId);
    return { kind: s.kind, reason: s.reason, appeal: s.appeal };
  },
  describe: (_ctx, a, state) => {
    const st = state as { reason: string | null };
    return {
      summary: pair(
        'ابعت اعتراض على إيقاف المتجر لفريق Ebda Store. هم اللي بيقرروا، ومفيش حاجة بتتفعّل لوحدها.',
        'Send an appeal against the store suspension to the Ebda Store team. They decide; nothing is lifted automatically.'
      ),
      rows: [
        row('سبب الإيقاف', 'Suspension reason', st.reason, null),
        row('الاعتراض', 'Appeal', null, a.message),
      ],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const row_ = await fileAppeal(trustDb(), ctx.storeId, { userId: ctx.userId }, a.message);
    void deferAfterTenantCommit('suspension-appeal.notify', async () => {
      await notifyStaff({
        subject: `Suspension appeal from store ${ctx.storeId}`,
        lines: [`Store: ${ctx.storeId}`, 'Via: assistant', '', a.message],
        storeId: ctx.storeId,
        ref: { requestId: row_.id, kind: 'suspension_appeal' },
      });
    });
    return { id: row_.id };
  },
});

const storeLimitRequest = change<{ message: string }>({
  name: 'store_limit_request',
  capabilityId: 'onboarding.store-cap-request',
  description:
    'Ask the Ebda Store team for a higher limit on how many stores I can own, with the reason. One open request at a time. Staff decide; this never raises the limit by itself. Say: "I need more stores", "raise my store limit".',
  schema: shape<{ message: string }>(
    {
      message: f.str('Why the merchant needs more stores (at least 10 characters).', {
        max: 1000,
        min: 10,
      }),
    },
    ['message']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  // POST /onboarding/store-cap-requests: authorize('store_admin', 'super_admin'), keyed on the user (no store in the route)
  gate: { roles: OWNER },
  audit: { action: 'onboarding.store_cap_request', resourceType: 'trust_request' },
  state: async () => ({ channel: 'store_cap' }),
  describe: (_ctx, a) => ({
    summary: pair(
      'اطلب من فريق Ebda Store يزوّد عدد المتاجر المسموح بيها ليك. هم اللي بيقرروا.',
      'Ask the Ebda Store team to raise how many stores you may own. They decide.'
    ),
    rows: [row('السبب', 'Reason', null, a.message)],
    affectedCount: 1,
  }),
  run: async (ctx, a) => {
    const row_ = await withUser(ctx.userId, tx =>
      fileStoreCapRequest(asTrustDb(tx), { userId: ctx.userId }, { message: a.message })
    );
    void deferAfterTenantCommit('onboarding-request.notify', () =>
      notifyStaff({
        subject: 'Store limit request',
        lines: ['Via: assistant', '', a.message],
        ref: { requestId: row_.id, kind: 'store_cap' },
      })
    );
    return { id: row_.id };
  },
});

export function trustTools(): ToolSpec[] {
  return [contactSupport, suspensionAppeal, storeLimitRequest];
}
