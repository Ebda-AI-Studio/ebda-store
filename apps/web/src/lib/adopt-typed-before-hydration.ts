/**
 * QA P2-1: a shopper who types before the page hydrates writes into the server-rendered DOM only. React 18 keeps that
 * text on hydration, but the component state is still empty, so the next re-render (typing in the NEXT field) writes
 * the empty state back over it: the first name vanished. On mount, read what is already in the named inputs so state
 * and screen agree. Returns only the non-empty values, keyed by input `name`.
 */
export function readTypedBeforeHydration<K extends string>(
  form: HTMLFormElement | null,
  keys: readonly K[]
): Partial<Record<K, string>> {
  const typed: Partial<Record<K, string>> = {};
  if (!form) return typed;
  for (const key of keys) {
    const el = form.elements.namedItem(key);
    if (el instanceof HTMLInputElement && el.value !== '') typed[key] = el.value;
  }
  return typed;
}
