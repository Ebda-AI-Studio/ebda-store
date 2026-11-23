/**
 * Capabilities the Ebda Store assistant never DOES, only points at (plan 4 SL-SCOPE-1, secrets rule, spec 6.9 gap 19): passwords, MFA secrets, passkey
 * ceremonies, card details, provider/model API keys, one-time tokens and OAuth sign-ins are never typed in chat. For these the tool is `show_me_where`
 * (a deep link to the secure screen) and the non-secret parts of the task are still done by other tools. Each entry names the secret that keeps it out of chat.
 */
// pq-allow(unused-export): imported by tests/unit/assistant-coverage.test.ts (the coverage guard); the assistant itself reaches these through show_me_where
export const DEEP_LINK_ONLY: Record<string, { secret: string }> = {
  'account.password': { secret: 'password' },
  'account.mfa': { secret: 'MFA secret and recovery codes' },
  'account.passkeys': { secret: 'passkey ceremony' },
  'account.login': { secret: 'password / one-time code' },
  'account.verify-email': { secret: 'one-time link or code' },
  'account.staff-accept-invite': { secret: 'invite token and new password' },
  'onboarding.signup': { secret: 'password / one-time code' },
  'billing.pay-card': { secret: 'card details' },
  'tax.change-request': {
    secret:
      'the tax card / certificate FILE upload and a single-use confirm token (a document is never attached in chat)',
  },
  'payment.card-providers': { secret: 'provider API keys' },
  'payment.instapay-merchant': { secret: 'provider credentials' },
  'self.provider-self-activation': {
    secret:
      'provider API keys (the on switch runs a server-side connection test with the saved keys and a single-use, test-run-bound confirmation; chat cannot stand in for that screen)',
  },
  'onboarding.slug-claim': {
    secret:
      'proof-of-ownership evidence (document link) for a protected address; filed before a store exists, so it has no store for the assistant to act in',
  },
};

/** Capabilities another plan owns on this same engine, with who owns them. Not a hole: the owning plan registers the tools. */
// pq-allow(unused-export): imported by tests/unit/assistant-coverage.test.ts (the coverage guard)
export const OWNED_ELSEWHERE: Record<string, string> = {
  'builder.edit-page': 'page-builder-v2',
  'builder.publish-rollback': 'page-builder-v2',
  'builder.ai-patch': 'page-builder-v2',
  'ai.assistant-actions':
    'smart-layer engine (its own apply / undo / confirm / reject routes: it is the mechanism, not a task)',
};
