import { withStore, withUser } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { inngest } from '../lib/inngest/client';
import { storeWritesToDo } from '../lib/repo-factory';
import { ownerStores } from '../lib/store-create-do';
import { StoreService } from './store.service';
import { BILLED_SUBSCRIPTION_STATUSES } from './account-closure-guard';
import { EmailService } from './email.service';
import { sortOwnerStores } from './billing/billing-parent';
import { moneyInFlight } from './store-closure.service';
import type { DeletionDeps, DeletionRequest } from './store-deletion.service';

/** Production wiring of the owner store-deletion policy (store-deletion.service.ts): kept apart so the policy is unit-tested without a database. */
export function productionDeletionDeps(): DeletionDeps {
  return {
    now: () => Date.now(),
    async loadStore(storeId) {
      let row;
      try {
        row = await StoreService.getById(storeId);
      } catch (e) {
        if (e instanceof AppError && e.statusCode === 404) return null;
        throw e;
      }
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        ownerId: row.ownerId ?? null,
        deletionRequest: (settings.deletionRequest as DeletionRequest | undefined) ?? null,
      };
    },
    saveRequest: (storeId, request) => StoreService.setDeletionRequest(storeId, request),
    transition: (storeId, from, to) => StoreService.compareAndSetDeletionRequest(storeId, from, to),
    async moneyInFlight(storeId) {
      // A store on its Durable Object keeps its money there and its check is atomic with the close (closeIfNoMoneyInFlight): it
      // runs at execution, inside StoreService.delete. Reading it here would need a close-and-reopen probe, so it is not done.
      if (await storeWritesToDo(storeId)) return null;
      const flight = await withStore(storeId, tx => moneyInFlight(tx, storeId));
      return { ...flight } as Record<string, number>;
    },
    async hasBilledSubscription(storeId) {
      const sub = await withStore(storeId, tx =>
        tx.storeSubscription.findUnique({ where: { storeId }, select: { status: true } })
      );
      return !!sub && (BILLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status);
    },
    async isBillingParentWithSiblings(store) {
      if (!store.ownerId) return false;
      const ownerId = store.ownerId;
      const family = sortOwnerStores(
        await ownerStores(ownerId, () =>
          withUser(ownerId, tx =>
            tx.store.findMany({
              where: { ownerId, deletedAt: null },
              select: { id: true, createdAt: true },
            })
          )
        )
      );
      return family.length > 1 && family[0].id === store.id;
    },
    async deleteStore(storeId, actorUserId) {
      await StoreService.delete(storeId, actorUserId);
    },
    async audit(entry) {
      await auditLog({
        action: entry.action,
        userId: entry.userId,
        // the store row is gone when the delete audit is written: no FK to point at, the id travels in resourceId
        storeId: entry.action === 'STORE_DELETED_BY_OWNER' ? undefined : entry.storeId,
        resourceType: 'store',
        resourceId: entry.storeId,
        details: entry.details,
      } as Parameters<typeof auditLog>[0]);
    },
    async emit(name, data) {
      await inngest.send({ name, data });
    },
    async notifyOwner(kind, info) {
      if (!info.to) return;
      const when = info.executeAfter ? info.executeAfter.slice(0, 10) : '';
      const copy = {
        scheduled: {
          subject: `Ebda Store: ${info.storeName} will be deleted on ${when}`,
          en: `You asked to delete ${info.storeName} (${info.slug}). It will be deleted on ${when}. Until then you can cancel from Settings > Danger zone.`,
          ar: `طلبت حذف متجر ${info.storeName} (${info.slug}). هيتحذف يوم ${when}. لحد وقتها تقدر تلغي الطلب من الإعدادات، منطقة الخطر.`,
        },
        cancelled: {
          subject: `Ebda Store: deletion of ${info.storeName} cancelled`,
          en: `The scheduled deletion of ${info.storeName} (${info.slug}) was cancelled. Nothing was deleted.`,
          ar: `اتلغى طلب حذف متجر ${info.storeName} (${info.slug}). مفيش حاجة اتمسحت.`,
        },
        executed: {
          subject: `Ebda Store: ${info.storeName} was deleted`,
          en: `${info.storeName} (${info.slug}) was deleted as you requested.`,
          ar: `متجر ${info.storeName} (${info.slug}) اتحذف زي ما طلبت.`,
        },
      }[kind];
      await EmailService.sendPlatformRaw({
        to: info.to,
        subject: copy.subject,
        html: `<p>${escapeHtml(copy.en)}</p><p dir="rtl">${escapeHtml(copy.ar)}</p>`,
        text: `${copy.en}\n\n${copy.ar}`,
      });
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}
