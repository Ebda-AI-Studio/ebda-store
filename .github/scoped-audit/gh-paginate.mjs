/**
 * Read a GitHub list endpoint to the end, and say whether it got to the end.
 *
 * Every list call in this gate wants the whole set, and each one that asked for
 * `per_page=100` and stopped got a silent, plausible-looking prefix instead: the
 * followup dedup compared against 100 of 703 open issues and re-filed the rest,
 * and the marker-comment lookup would post a duplicate audit comment on any PR
 * whose marker had slipped past the first page.
 *
 * The second half of the signature matters more than the first. On the run that
 * exposed this, EVERY call failed with `fetch failed`, each one caught as
 * non-fatal — so the dedup fell back to an empty set, which does not read as
 * "the lookup broke" but as "nothing is tracked yet, file all of it". A partial
 * read degrades the same way, quietly and in the direction of more issues. So
 * this reports completeness alongside the items and lets the caller decide;
 * callers that are about to WRITE something must fail closed on `complete:
 * false` rather than act on a set they cannot vouch for.
 *
 * One implementation, imported — the two copies are what drifted.
 */

/** GitHub clamps `per_page` at 100; asking for more silently gets 100. */
const PER_PAGE = 100;

/**
 * @param gh       the repo's authenticated fetch wrapper: (method, path) => Response
 * @param path     a list endpoint path; may already carry a query string
 * @param maxPages a runaway stop; hitting it means the read is NOT complete
 * @returns `{ items, complete }` — `complete` is true only when every page was
 *          read successfully through to a short page
 */
export async function fetchAllPages({ gh, path, maxPages = 30 }) {
  const joiner = path.includes('?') ? '&' : '?';
  const items = [];

  for (let page = 1; page <= maxPages; page++) {
    let resp;
    try {
      resp = await gh('GET', `${path}${joiner}per_page=${PER_PAGE}&page=${page}`);
    } catch {
      return { items, complete: false };
    }
    if (!resp.ok) return { items, complete: false };

    let batch;
    try {
      batch = await resp.json();
    } catch {
      return { items, complete: false };
    }
    if (!Array.isArray(batch)) return { items, complete: false };

    items.push(...batch);

    if (batch.length < PER_PAGE) return { items, complete: true };
  }

  // Ran out of pages before running out of results.
  return { items, complete: false };
}
