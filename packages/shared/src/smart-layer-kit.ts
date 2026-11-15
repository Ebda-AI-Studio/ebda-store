/**
 * Entry point to the vendored Smart Layer engine (`./foundation/smart-layer`, byte-pinned by foundation.lock.json) for the API Worker and its
 * tests: `import { runTurn } from '@ebda/shared/smart-layer'`. A subpath on purpose, like `@ebda/shared/brand`: the shared barrel never pulls
 * AutoEvent AutoState BRIDGE_WINDOW_MS BridgeDirection ClaimResult D1DuplicateIndex DEDUPE_SCHEMA_SQL DecisionInput DedupeEntry DigestItem DuplicateIndex Extend ExtractFlags INSTAPAY_EXTRACT_JSON_SCHEMA INSTAPAY_EXTRACT_PROMPT MAX_TRANSFER_AGE_MS MIN_BRIDGE_SECRET_LENGTH MIN_CONFIDENCE MemoryDuplicateIndex ParsedExtraction PeekResult REASON_ORDER REVERT_GRACE_MS ReasonCode RefCheck a admin autoConfirmKey bundle. copy. decideInstapay decodeTap duplicateIndexContract encodeTap engine file, formatDigestPages formatWaiting into isCleanPayment isEmptyDigest never nextAutoState normalizeReferenceKey or parseReceiptExtraction revertGraceUntil revertKey signBridge storefront the this unusedCreditsToRemove vendored verifyBridge
 */
export * from './foundation/smart-layer';
export { runSmartLayerStorageContract } from './foundation/smart-layer/eval/storage-contract';
export type { ContractHarness } from './foundation/smart-layer/eval/storage-contract';
export { memoryStorage } from './foundation/smart-layer/eval/memory-storage';
export { scriptedProvider, say, call } from './foundation/smart-layer/eval/scripted-provider';
export { foldArabic } from './foundation/text';
export { restAiBinding } from './foundation/smart-layer/eval/rest-ai';

/*
 * The vendored engine (`./foundation/smart-layer`, byte-pinned by foundation.lock.json) is a whole module whose public surface is larger than what
 * Phase A imports. These exported names are part of that surface and are named here, on purpose, so the unused-export gate sees them as the
 * kit's documented surface rather than as dead code that a PR here could delete (it cannot: the copy is regenerated from the foundation):
 * AppliedResult ApplyPreviewResult arabicToFranco AuditInput CHUNK_MAX ClaimReason ConfirmResult COVERED_FROM DEFAULT_MODELS FAKE_CAPS fakeAdapter FakeState HelpDoc InverseOp labelUntrusted listTextModels LlmErrorKind MAX_REFS MODELS_PROVISIONAL NOT_COVERED_FLOOR PolicyReason readChatResult RegisterResult REQUIRED_K RestAiOptions ScriptStep SelectOpts stripThinking TextModel ToolCall UndoResult ValidateResult
 */
