import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@ebda/database';
import {
  TAX_CHANGE_SETTING_PREFIX,
  TAX_DOCUMENT_MAX_BYTES,
  normalizeTaxRegistrationNumber,
  type TaxChangeDecision,
  type TaxDocumentKindValue,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { StorageService } from './storage.service';
import { sendAlert } from './alerts.service';
import {
  TaxProfileService,
  sniffTaxDocumentMime,
  applyApprovedTaxChange,
  storesHoldingTrns,
} from './tax-profile.service';
import { readTaxDocument, type TaxDocumentExtraction } from '../lib/ai/tax-document-reader';
import {
  consumeConfirmToken,
  hashConfirmArgs,
  signConfirmToken,
  verifyConfirmToken,
} from '../mcp/merchant-confirm-token';
import { withPlatformUser } from '../lib/platform-scope';
import { claimPendingChangeD1 } from './tax-change-claim';
import logger from '../lib/logger';

/**
 * Change of a VERIFIED VAT registration (self-service A10).
 *
 * The verified profile is never touched while a request is pending: VAT keeps charging under the old identity and the
 * merchant keeps the old verified state. The request lives in ONE `system_settings` row per store
 * (`tax.change.<storeId>`, the same platform-global home as `ebda.vat`), so the super-admin queue is one prefix read
 * and no tenant table / Durable Object migration is needed. The evidence file sits in the PRIVATE bucket (ruling TAX-4).
 *
 * Boundary: the AI only EXTRACTS two fields off the document; `precheck` below is plain code; every request is decided by
 * a super-admin (approve / reject), the legal call stays human. A mismatch is a flag, never an approval.
 */

// ONE prisma site: `system_settings` is a D1-routed platform model (services/platform/router.ts), like `ebda.vat`.
const settings = () => prisma.systemSetting;

const TOOL = 'tax.change-request';
// The admin session has no MCP key; the token is still bound to tool + store + actor + payload hash.
const KEY_ID = 'admin-session';

type Actor = { userId: string; ip?: string; userAgent?: string };

interface TaxChangeInput {
  taxRegistrationNumber: string;
  legalName: string;
  kind: TaxDocumentKindValue;
}
interface TaxChangeFile {
  buffer: Buffer;
  originalname: string;
}

type TaxChangeFlag =
  | 'trn_mismatch'
  | 'name_mismatch'
  | 'trn_unreadable'
  | 'name_unreadable'
  | 'looks_edited'
  | 'low_confidence'
  | 'not_pre_checked'
  | 'trn_in_use_by_other_store';

interface StoredChange {
  id: string;
  taxRegistrationNumber: string;
  legalName: string;
  kind: TaxDocumentKindValue;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  requestedBy: string;
  requestedAt: string;
  /** The profile's reviewedAt when requested; apply refuses when the profile was re-reviewed since (revoke / re-verify). */
  profileReviewedAt: string | null;
  precheck: {
    status: 'clean' | 'flagged';
    flags: TaxChangeFlag[];
    extracted: { taxRegistrationNumber: string | null; legalName: string | null } | null;
  };
}

/** Name text that survives spacing, punctuation, case, Arabic diacritics and alef / ya / ta-marbuta spelling variants. */
function foldName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const LOW_CONFIDENCE = 0.6;

/** Plain-code comparison of what the merchant typed with what the model read. No AI judgement is trusted here. */
function precheck(
  entered: TaxChangeInput,
  extracted: TaxDocumentExtraction | null
): StoredChange['precheck'] {
  if (!extracted) return { status: 'flagged', flags: ['not_pre_checked'], extracted: null };
  const flags: TaxChangeFlag[] = [];
  const trn = extracted.taxRegistrationNumber
    ? normalizeTaxRegistrationNumber(extracted.taxRegistrationNumber)
    : '';
  if (!/^\d{9}$/.test(trn)) flags.push('trn_unreadable');
  else if (trn !== entered.taxRegistrationNumber) flags.push('trn_mismatch');
  const name = extracted.legalName ? foldName(extracted.legalName) : '';
  if (!name) flags.push('name_unreadable');
  else if (name !== foldName(entered.legalName)) flags.push('name_mismatch');
  if (extracted.looksEdited) flags.push('looks_edited');
  if (extracted.confidence === null || extracted.confidence < LOW_CONFIDENCE)
    flags.push('low_confidence');
  return {
    status: flags.length === 0 ? 'clean' : 'flagged',
    flags,
    extracted: {
      taxRegistrationNumber: trn || null,
      legalName: extracted.legalName,
    },
  };
}

const keyOf = (storeId: string) => `${TAX_CHANGE_SETTING_PREFIX}${storeId}`;

async function readStored(storeId: string): Promise<StoredChange | null> {
  const row = await settings().findUnique({
    where: { key: keyOf(storeId) },
    select: { value: true },
  });
  return row ? (row.value as unknown as StoredChange) : null;
}

const resultKeyOf = (storeId: string) => `tax.change-result.${storeId}`;

/**
 * Deletes the pending row and says whether THIS call removed it (the atomic claim a decision takes first). With `requestId` the
 * claim only matches THAT request (JSON path on the stored id): a withdraw + resubmit while a decision is in flight is a different
 * request and must not be claimed (nor its evidence orphaned) by the older decision.
 */
async function deleteStored(storeId: string, requestId?: string): Promise<boolean> {
  // On D1 the lite deleteMany count is not atomic (see tax-change-claim.ts): claim by id with ONE statement.
  if (requestId) {
    const claimed = await claimPendingChangeD1(keyOf(storeId), requestId);
    if (claimed !== null) return claimed;
  }
  const out = await settings().deleteMany({
    where: {
      key: keyOf(storeId),
      ...(requestId ? { value: { path: ['id'], equals: requestId } } : {}),
    },
  });
  return out.count > 0;
}

/** A silent failure path an operator must see: the request or its notice would otherwise vanish without a trace. */
function pageSilentFailure(storeId: string, title: string, err: unknown): void {
  logger.error({ err, storeId }, `[tax-change] ${title}`);
  void sendAlert({
    level: 'p1',
    scope: 'store',
    store: { id: storeId, name: storeId },
    source: 'tax-change.silent-failure',
    title: `VAT change request: ${title}`,
    body: `${title} for store ${storeId}. Check the pending request and the merchant's last notice by hand.`,
  }).catch(() => undefined);
}

async function dropEvidence(change: StoredChange, storeId: string): Promise<void> {
  await StorageService.deletePrivate(change.storageKey).catch(err =>
    logger.error({ err, storeId }, '[tax-change] could not remove the evidence object')
  );
}

/** What the merchant sees: the request itself, never the pre-check. */
function merchantView(c: StoredChange) {
  return {
    id: c.id,
    taxRegistrationNumber: c.taxRegistrationNumber,
    legalName: c.legalName,
    kind: c.kind,
    fileName: c.fileName,
    requestedAt: c.requestedAt,
  };
}

function validate(file: TaxChangeFile): 'application/pdf' | 'image/jpeg' | 'image/png' {
  if (file.buffer.length === 0 || file.buffer.length > TAX_DOCUMENT_MAX_BYTES)
    throw new AppError(400, 'FILE_TOO_LARGE', 'Document must be between 1 byte and 10 MB');
  const mime = sniffTaxDocumentMime(file.buffer);
  if (!mime)
    throw new AppError(
      400,
      'INVALID_FILE_TYPE',
      'Upload a PDF, JPG or PNG. / ارفع ملف PDF أو JPG أو PNG.'
    );
  return mime;
}

async function assertChangeable(storeId: string) {
  const profile = await TaxProfileService.get(storeId);
  if (profile.status !== 'verified')
    throw new AppError(
      409,
      'TAX_CHANGE_NOT_APPLICABLE',
      'Only a verified VAT registration is changed this way; edit and submit your details instead. / يتم تغيير التسجيل الموثّق بهذه الطريقة فقط؛ عدّل بياناتك وأرسلها للمراجعة في الحالات الأخرى.'
    );
  if (await readStored(storeId))
    throw new AppError(
      409,
      'TAX_CHANGE_PENDING',
      'A change request is already waiting for review. Withdraw it to send a new one. / عندك طلب تغيير في انتظار المراجعة. اسحبه لو عايز تبعت طلب جديد.'
    );
  return profile;
}

function subjectFor(storeId: string, actor: Actor, input: TaxChangeInput, sha256: string) {
  return {
    tool: TOOL,
    storeId,
    keyId: KEY_ID,
    userId: actor.userId,
    argsHash: hashConfirmArgs({ ...input, sha256 }),
  };
}

type SubmitResult =
  | {
      confirmationRequired: true;
      confirmToken: string;
      preview: TaxChangeInput & { fileName: string };
    }
  | { confirmationRequired: false; request: ReturnType<typeof merchantView> };

/**
 * One entry point for both calls of the confirm round-trip (policy `confirm`): without a token the answer is a preview and a
 * server-issued, single-use token bound to a hash of the previewed payload (TRN, name, kind, file sha256); with the token the
 * request is created. An edited payload or a replayed token is refused.
 */
export async function requestTaxChange(
  storeId: string,
  actor: Actor,
  input: TaxChangeInput,
  file: TaxChangeFile,
  confirmToken: string | undefined
): Promise<SubmitResult> {
  const mime = validate(file);
  const profile = await assertChangeable(storeId);
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  const subject = subjectFor(storeId, actor, input, sha256);
  if (!confirmToken) {
    return {
      confirmationRequired: true,
      confirmToken: signConfirmToken(subject),
      preview: { ...input, fileName: file.originalname.slice(0, 200) },
    };
  }
  if (!verifyConfirmToken(confirmToken, subject))
    throw new AppError(
      409,
      'CONFIRMATION_INVALID',
      'The confirmation does not match what you are sending. Review and confirm again. / التأكيد مش مطابق للي بتبعته. راجع وأكّد تاني.'
    );
  // Slow work FIRST (AI read, private upload): a failure here, or in the row write below, never burns the token.
  const extracted = await readTaxDocument({ storeId, image: file.buffer, mimeType: mime });
  const { key } = await StorageService.putPrivate(file.buffer, {
    storeId,
    folder: 'tax-documents',
    ext: mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg',
    contentType: mime,
  });
  const change: StoredChange = {
    id: randomUUID(),
    taxRegistrationNumber: input.taxRegistrationNumber,
    legalName: input.legalName,
    kind: input.kind,
    storageKey: key,
    fileName: (file.originalname || 'document').slice(0, 200),
    mimeType: mime,
    sizeBytes: file.buffer.length,
    sha256,
    requestedBy: actor.userId,
    requestedAt: new Date().toISOString(),
    profileReviewedAt: profile.reviewedAt ? new Date(profile.reviewedAt).toISOString() : null,
    precheck: precheck(input, extracted),
  };
  try {
    // The atomic step: the unique key admits ONE request; of two concurrent confirms the loser gets a clear 409.
    await settings().create({
      data: { key: keyOf(storeId), value: change as never, category: 'tax', isPublic: false },
    });
  } catch (err) {
    await dropEvidence(change, storeId); // compensate: no orphaned object, token untouched
    if (await readStored(storeId).catch(() => null))
      throw new AppError(
        409,
        'TAX_CHANGE_PENDING',
        'A change request is already waiting for review. / عندك طلب تغيير في انتظار المراجعة.'
      );
    throw err;
  }
  // The new request replaces the last answer; only now, so a failed create never deletes the merchant's last rejection notice.
  await settings()
    .deleteMany({ where: { key: resultKeyOf(storeId) } })
    .catch(err => logger.error({ err, storeId }, '[tax-change] could not clear the last answer'));
  // Only now spend the single-use token. A replay (token already used) rolls the row and the object back.
  let used = false;
  try {
    used = await consumeConfirmToken(confirmToken);
  } finally {
    if (!used) {
      await deleteStored(storeId, change.id).catch(() => undefined);
      await dropEvidence(change, storeId);
    }
  }
  if (!used)
    throw new AppError(
      409,
      'CONFIRMATION_USED',
      'This confirmation was already used. Review and confirm again. / التأكيد ده اتستخدم قبل كده. راجع وأكّد تاني.'
    );
  // The request exists and the token is spent: follow-ups must not turn this into a failure.
  await auditLog({
    action: 'tax_profile.change_requested',
    userId: actor.userId,
    storeId,
    resourceType: 'store_tax_profile',
    resourceId: change.id,
    details: {
      taxRegistrationNumberLast3: input.taxRegistrationNumber.slice(-3),
      sha256,
      precheck: change.precheck.status,
      flags: change.precheck.flags,
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  }).catch(err => logger.error({ err, storeId }, '[tax-change] audit row could not be written'));
  // p1 only for a real signal (a different number or name, an edited-looking image); a PDF or AI off is routine.
  const signal = change.precheck.flags.some(f =>
    ['trn_mismatch', 'name_mismatch', 'looks_edited'].includes(f)
  );
  void sendAlert({
    level: signal ? 'p1' : 'info',
    scope: 'store',
    store: { id: storeId, name: storeId },
    source: 'tax-change.requested',
    title: 'VAT registration change request',
    body: `Pre-check: ${change.precheck.status}${change.precheck.flags.length ? ` (${change.precheck.flags.join(', ')})` : ''}. Review it in the VAT verification queue.`,
  }).catch(() => undefined);
  return { confirmationRequired: false, request: merchantView(change) };
}

/** The pending request (if any) and the reason of the last rejection (if the last answer was a rejection). */
export async function getTaxChangeForMerchant(storeId: string) {
  const c = await readStored(storeId);
  const last = await settings().findUnique({
    where: { key: resultKeyOf(storeId) },
    select: { value: true },
  });
  return {
    request: c ? merchantView(c) : null,
    lastRejection: last ? (last.value as unknown as { reason: string; at: string }) : null,
  };
}

/** The merchant withdraws their own pending request (reversible: they can send a new one). */
export async function withdrawTaxChange(storeId: string, actor: Actor): Promise<void> {
  const c = await readStored(storeId);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'No pending change request');
  if (!(await deleteStored(storeId, c.id))) return; // already decided or replaced: nothing of this request left to remove
  await dropEvidence(c, storeId);
  await auditLog({
    action: 'tax_profile.change_withdrawn',
    userId: actor.userId,
    storeId,
    resourceType: 'store_tax_profile',
    resourceId: c.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** Super-admin queue: every pending request with its pre-check, oldest first. */
export async function listTaxChangesForReview(adminId: string) {
  const rows = await withPlatformUser(adminId, () =>
    settings().findMany({
      where: { key: { startsWith: TAX_CHANGE_SETTING_PREFIX } },
      select: { key: true, value: true },
      take: 500,
    })
  );
  // The same cross-store duplicate signal as the main VAT review: another store holding the requested number is a flag.
  const holders = await withPlatformUser(adminId, () =>
    storesHoldingTrns(rows.map(r => (r.value as unknown as StoredChange).taxRegistrationNumber))
  );
  return (
    rows
      .map(r => {
        const rest: Omit<StoredChange, 'storageKey'> & { storageKey?: string } = {
          ...(r.value as unknown as StoredChange),
        };
        delete rest.storageKey; // the private object key never leaves the server
        const storeId = r.key.slice(TAX_CHANGE_SETTING_PREFIX.length);
        const taken = (holders.get(rest.taxRegistrationNumber) ?? []).some(
          h => h.storeId !== storeId
        );
        if (taken && rest.precheck) {
          rest.precheck = {
            ...rest.precheck,
            status: 'flagged',
            flags: [...(rest.precheck.flags ?? []), 'trn_in_use_by_other_store'],
          };
        }
        return { storeId, ...rest };
      })
      // Oldest first. A malformed row without `requestedAt` (never written by requestTaxChange) sorts FIRST so a reviewer sees it
      // instead of it throwing the whole queue.
      .sort((a, b) => (a.requestedAt ?? '').localeCompare(b.requestedAt ?? ''))
  );
}

export async function readTaxChangeEvidence(
  storeId: string
): Promise<{ body: Buffer; mimeType: string; fileName: string }> {
  const c = await readStored(storeId);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'No pending change request');
  const { body } = await StorageService.getPrivate(c.storageKey);
  return { body, mimeType: c.mimeType, fileName: c.fileName };
}

/**
 * Super-admin decision on a pending request. Approve writes the new identity onto the verified profile (the DB trigger and the
 * DO guard let only a super_admin do that) and keeps the evidence as a profile document; reject deletes the evidence and tells
 * the merchant why (`tax.change-result.<storeId>`, cleared by the next request). Either way the request row is removed.
 */
export async function decideTaxChange(
  storeId: string,
  decision: TaxChangeDecision,
  actor: Actor
): Promise<{ decision: TaxChangeDecision['decision']; noop?: true }> {
  const c = await readStored(storeId);
  // Idempotent: a request already decided (or never made) is a no-op, never a second apply.
  if (!c) return { decision: decision.decision, noop: true };
  // The decision is bound to the request the reviewer SAW (id + document sha256 + number): a request replaced since the list was
  // loaded is a different request and is never approved or rejected by this click. Nothing is claimed or applied.
  if (
    c.id !== decision.requestId ||
    c.sha256 !== decision.sha256 ||
    c.taxRegistrationNumber !== decision.taxRegistrationNumber
  )
    throw new AppError(
      409,
      'TAX_CHANGE_STALE',
      'This request changed after you opened it. Reload the queue and review it again. / الطلب اتغيّر بعد ما فتحته. حدّث القائمة وراجعه تاني.'
    );
  // Claim first: of two concurrent decisions only the one that removes the row proceeds; the other is a no-op (no double apply).
  if (!(await deleteStored(storeId, c.id))) return { decision: decision.decision, noop: true };
  if (decision.decision === 'approve') {
    try {
      await applyApprovedTaxChange(storeId, c, actor);
    } catch (err) {
      // nothing was applied: put the request back so it can be decided again
      await settings()
        .create({
          data: { key: keyOf(storeId), value: c as never, category: 'tax', isPublic: false },
        })
        .catch(restoreErr =>
          // a newer request already holds the key, or the write failed: the old request is gone, say so
          pageSilentFailure(storeId, 'restore after a failed approve did not happen', restoreErr)
        );
      throw err;
    }
    await settings().deleteMany({ where: { key: resultKeyOf(storeId) } });
  } else {
    // The claim already happened: a notice that cannot be saved must not undo the rejection (page instead).
    await settings()
      .upsert({
        where: { key: resultKeyOf(storeId) },
        create: {
          key: resultKeyOf(storeId),
          value: { reason: decision.reason, at: new Date().toISOString() },
          category: 'tax',
          isPublic: false,
        },
        update: { value: { reason: decision.reason, at: new Date().toISOString() } },
      })
      .catch(err => pageSilentFailure(storeId, 'rejection notice could not be saved', err));
    await dropEvidence(c, storeId);
  }
  await auditLog({
    action:
      decision.decision === 'approve'
        ? 'tax_profile.change_approved'
        : 'tax_profile.change_rejected',
    userId: actor.userId,
    storeId,
    resourceType: 'store_tax_profile',
    resourceId: c.id,
    details: {
      precheck: c.precheck.status,
      flags: c.precheck.flags,
      ...(decision.decision === 'reject' ? { reason: decision.reason } : {}),
    },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { decision: decision.decision };
}

/** A revoke, a store deletion or a fresh verification makes a pending change meaningless: drop it, its last answer and its evidence (reusable by store deletion). */
export async function discardTaxChange(storeId: string, actor?: Actor): Promise<void> {
  await settings().deleteMany({ where: { key: resultKeyOf(storeId) } });
  const c = await readStored(storeId);
  if (!c) return;
  if (!(await deleteStored(storeId, c.id))) return;
  await dropEvidence(c, storeId);
  await auditLog({
    action: 'tax_profile.change_discarded',
    userId: actor?.userId,
    storeId,
    resourceType: 'store_tax_profile',
    resourceId: c.id,
    details: { precheck: c.precheck.status, sha256: c.sha256 },
    ip: actor?.ip,
    userAgent: actor?.userAgent,
  }).catch(err => logger.error({ err, storeId }, '[tax-change] discard audit row failed'));
}
