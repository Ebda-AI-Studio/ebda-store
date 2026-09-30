/**
 * Recover findings from a model response that did not parse as complete JSON.
 *
 * On a very large diff (scripts/scoped-audit.sh caps the diff it sends the
 * model at ~150KB, roughly the ~12k-line diffs where this was first observed)
 * the model's OWN response can run long enough to be cut off mid-generation —
 * a `findings` array with a trailing incomplete object — which fails
 * `JSON.parse` outright. Before this, that meant the gate reported "DID NOT
 * RUN": the model demonstrably reviewed the diff and may have found real P0/P1
 * problems, it just ran out of room to finish writing them all down, and every
 * one of them was dropped with no trace — worse than reporting nothing, and on
 * exactly the largest, riskiest PRs where a careful review matters most.
 *
 * This walks the `findings` array by hand (a JSON.parse of the whole envelope
 * already failed, so no library parser will succeed either) and keeps every
 * finding object that is syntactically COMPLETE, stopping at the first one
 * that is not. A caller can then report a PARTIAL audit — real findings, with
 * an explicit note that the review did not reach the end of the diff — instead
 * of silence.
 */
export function recoverTruncatedFindings(text) {
  if (typeof text !== 'string') return null;

  const key = text.indexOf('"findings"');
  if (key === -1) return null;
  const arrayStart = text.indexOf('[', key);
  if (arrayStart === -1) return null;

  const findings = [];
  let i = arrayStart + 1;

  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === ']') break; // the array closed cleanly
    if (text[i] !== '{') break; // not another object — stop rather than guess

    const objStart = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closedAt = -1;

    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          closedAt = j + 1;
          break;
        }
      }
    }

    if (closedAt === -1) break; // truncated mid-object — this is the cutoff

    try {
      findings.push(JSON.parse(text.slice(objStart, closedAt)));
    } catch {
      break; // syntactically balanced but not valid JSON — do not guess
    }
    i = closedAt;
  }

  return findings.length ? { findings, truncated: true } : null;
}
