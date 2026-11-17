# Ebda launch readiness

Goal: signup → verified merchant → setup → product → COD → storefront order runs in workerd; public Ebda branding and actionable errors. Preserve existing data/payment contracts and Ebda Store source.

1. Audit runtime, tenant scope, wiring, branding and deployment inputs.
2. Fix confirmed defects with targeted regressions; require mobile server-side.
3. Build the API Worker; run Worker tests and a fresh local strict-RLS database flow.
4. Document verified launch matrix and external blockers; update PR without merging/deploying.

Ruling LAUNCH-1 — keep existing compatibility identifiers until callers can migrate together. Public naming is Ebda; renaming stored keys/resource IDs blindly risks losing user state. Cost if wrong: an internal identifier remains visible in debugging metadata.

Confirmed gaps: unsafe DB role guard; contextless cart/loyalty cron; setup back-navigation duplicate-store path; stale COD state; resend errors reported as success; placeholder Hyperdrive/KV; no API deployment workflow. Audit found GitHub Actions enabled and main default, so older docs listing them as blockers require correction.

Merge follow-up: PR #3 merged only the UI head; PR #4 carries backend fixes. Repair clean-install npm-version lock parity, synthetic fixture allowlisting, generated-artifact formatting, verify-email locale context and deterministic CI cache dry-runs before merging. Production deploy cache assertions stay strict.
