/**
 * Single entry point to the vendored @ebda/foundation guard modules (capability registry, coverage, self-service routes,
 * Smart Layer bypass, help linkage, ratchet, design-token guard rules). The product guard tests under tests/unit import
 * the guards from here; they are pure functions with no file access, so nothing in the runtime bundle pulls this in.
 * The vendored copy is byte-pinned (foundation.lock.json, foundation-parity test): extend this barrel, never the copy.
 */
export {
  POLICIES,
  STATUSES,
  UNDO_CLASSES,
  ROLES,
  OPERATOR_REASONS,
  capabilitySchema,
  guardConfigSchema,
  helpUrl,
  normalizeApi,
} from './foundation/capability';
export type { Capability, GuardConfig, Violation } from './foundation/capability';
export { checkRegistry } from './foundation/capability-registry';
export { checkCoverage, pageMatches } from './foundation/capability-coverage';
export type { CodeFacts } from './foundation/capability-coverage';
export { checkSelfServiceRoutes } from './foundation/self-service-routes';
export { MODEL_CALL_PATTERNS, checkModelBypass } from './foundation/smart-layer-bypass';
export { checkHelp, parseHelpFrontMatter, toHelpArticle } from './foundation/help-article';
export type { HelpArticle } from './foundation/help-article';
export { applyBaseline, baselineGrowth, guardOutcome, violationId } from './foundation/ratchet';
export {
  GUARD_RULES,
  classAttr,
  countRule,
  navIssues,
  openingTag,
  stripComments,
} from './foundation/guards';
export type { GuardRule } from './foundation/guards';
