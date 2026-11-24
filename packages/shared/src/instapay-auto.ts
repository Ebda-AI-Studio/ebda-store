/**
 * The vendored foundation InstaPay auto-confirm modules (foundation.lock.json, tag v0.3.0), re-exported under one roof so the API never
 * imports a vendored file by path. Names are prefixed `Auto`/`auto` only where the Store already has a same-named symbol.
 * Change behaviour in ebda-foundation and re-run `ebda-foundation sync`; never edit the vendored files.
 */
export {
  decideInstapay,
  normalizeHandle,
  REASON_ORDER,
  MAX_TRANSFER_AGE_MS,
  FUTURE_TOLERANCE_MS,
  MIN_CONFIDENCE,
  type ReasonCode,
  type DecisionInput,
  type Decision,
} from './foundation/instapay-decision';
export {
  parseReceiptExtraction,
  INSTAPAY_EXTRACT_PROMPT,
  INSTAPAY_EXTRACT_JSON_SCHEMA,
  type ReceiptExtract,
  type ParsedExtraction,
  type ExtractFlags,
} from './foundation/instapay-extract';
export {
  nextAutoState,
  autoConfirmKey,
  revertKey,
  revertGraceUntil,
  firstPaymentCapMinor,
  isCleanPayment,
  unusedCreditsToRemove,
  REVERT_GRACE_MS,
  type AutoState,
  type AutoEvent,
} from './foundation/instapay-state';
export {
  D1DuplicateIndex,
  MemoryDuplicateIndex,
  DEDUPE_SCHEMA_SQL,
  normalizeReferenceKey,
  duplicateIndexContract,
  type DuplicateIndex,
  type DedupeEntry,
  type ClaimResult,
  type PeekResult,
  type D1Like as DedupeD1Like,
} from './foundation/instapay-dedupe';
export {
  formatDigestPages,
  formatWaiting,
  encodeTap,
  decodeTap,
  isEmptyDigest,
  signBridge,
  verifyBridge,
  BRIDGE_WINDOW_MS,
  type DigestItem,
  type BridgeDirection,
} from './foundation/instapay-digest';
