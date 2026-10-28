# SEC-2 / SEC-11: AI review moderation and the InstaPay receipt reader

Audit 2026-10-26 (`M-065`, `M-133`). Code: `apps/api/src/lib/ai/review-moderation-policy.ts`,
`review-tools.ts`, `lib/inngest/functions/review-moderation.ts`,
`services/payment-providers/instapay-receipt.service.ts`, `packages/shared/src/instapay-receipt.ts`,
`apps/admin/src/components/instapay/InstapayReceiptReview.tsx`.

## SEC-2: a review can no longer talk its way to "published"

Before: the model's `spamScore` alone chose the status, `parsed.spamScore || 0` turned a missing or
null score into 0 (= published), and a non-numeric string became `NaN`, which fails both thresholds
(= published). The review title and body were pasted straight into the prompt.

Now:

| Rule                                                                                                                                                                                                                                                                                          | Where             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Fail closed: a score that is not a finite number (missing, null, string, NaN, Infinity, unparseable reply) gives status `pending` and `spamScore = null`                                                                                                                                      | `scoreToStatus`   |
| The untrusted review text sits between two random per-call boundary lines, the prompt calls it data, and a copy of the boundary inside the text is stripped; body capped at 4000 chars                                                                                                        | `buildSpamPrompt` |
| Deterministic pre-filter, no model involved: link (scheme, `www.`, bare domain, "x dot com", `t.me`/`wa.me`/`bit.ly`, `@handle`), phone number (8+ digits, Arabic-Indic too), profanity (EN + AR short list), text that addresses the moderator ("spamScore", "ignore previous instructions") | `prefilterReview` |
| A pre-filter hit can only demote `published` to `pending`; `spam` stays `spam`. A review with a URL is never auto-published, whatever the model says                                                                                                                                          | `applyPrefilter`  |
| Reasons from the model are kept only if they are an array of strings (200 chars, 10 max); the pre-filter reasons are appended                                                                                                                                                                 | `sanitizeReasons` |

Tuning: the profanity list is deliberately short and unambiguous; a hit only holds the review for a
human, it never deletes it. Add words in `PROFANITY`.

Ruling SEC-2a - the pre-filter holds a review with a phone number even when the model says it is
genuine. Evidence: the finding asks for phone and link filters; a merchant sees the review in the
pending queue and approves it in one click. Cost if wrong: genuine reviews that quote an order
number of 8+ digits wait for a merchant click instead of publishing at once.

## SEC-11: "no warnings" is never a positive signal on an InstaPay receipt

The reader (`instapay-receipt-reader.ts`) trusts the model's `looksEdited` and `confidence`, and the
payer controls the image, so text in a screenshot can suppress both flags. A human still approves
every receipt, the payer's form is only pre-filled, and a duplicate reference is blocked by a unique
key.

Now:

- `InstapayReceiptReview` always shows an "AI read is advisory and can be fooled by text inside the
  image; check amount, receiver and date yourself" note (`role="note"`), with or without flags.
- A new rule-based flag `SUSPICIOUS_TEXT` (`hasInstructionLikeText`, shared) fires when any
  extracted text field (note, names, handles, bank) reads like an instruction ("looksEdited",
  "confidence", "ignore previous", "system prompt", "no warnings", "json", Arabic equivalents). It
  does not depend on the model flags, so a screenshot cannot switch it off.
- The amount, receiver and date flags were already rule-based (`computeReceiptFlags`) and are unchanged.

Ruling SEC-11a - `SUSPICIOUS_TEXT` flags, it never blocks (same as every other receipt check).
Cost if wrong: an approver who ignores the badge approves a receipt the AI could not be trusted on;
the amount, receiver and date flags and the duplicate-reference key still apply.

Related: `M-003` (moving the reader to Workers AI keeps the same injection caveat).
