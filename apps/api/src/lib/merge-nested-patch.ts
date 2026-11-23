/** Shallow per-key merge of a nested settings object: `null` deletes the key, every other key of `stored` survives. */
export function mergeNestedPatch(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}
