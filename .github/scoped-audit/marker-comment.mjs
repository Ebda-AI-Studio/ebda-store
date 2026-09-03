/**
 * Which existing PR comment is this gate's own, given a possibly partial read.
 *
 * This was inline, untested, and shipped broken: the paginator was changed to
 * return `{ items, complete }` while the call site kept treating its result as
 * an array, so every run threw `existing.find is not a function` and the audit
 * could not post its findings at all. The gate still blocked the PR — leaving a
 * red X above whatever comment an earlier commit had left behind.
 *
 * So the decision lives here, where a test can hold it to the contract.
 *
 * The rule turns on a distinction the array shape could not express: not
 * finding the marker means "there is no previous comment" only when the whole
 * list was read. On a partial read it establishes nothing.
 *
 * What to DO about that uncertainty is the part worth stating plainly, because
 * the obvious answer is wrong. Refusing to post looks like the careful choice
 * and is not: this comment is the only place P3 and over-cap findings are ever
 * reported, so declining to write it converts an untidy PR into a silently
 * unreported finding — the precise failure this gate exists to prevent. A
 * duplicate comment is visible, cheap and reversible. So uncertainty is
 * reported, never enforced, and the caller posts anyway.
 */

/**
 * @returns `{ prior, uncertain }` — `prior` is the comment to edit, or null to
 *          post a new one; `uncertain` marks a null that the read could not
 *          actually establish, so the caller can say so while still posting.
 */
export function resolveMarkerComment({ items, complete, marker }) {
  const prior = items.find(c => c && typeof c.body === 'string' && c.body.includes(marker)) ?? null;

  // Found is found — a partial read that located it is still correct.
  if (prior) return { prior, uncertain: false };

  return { prior: null, uncertain: !complete };
}
