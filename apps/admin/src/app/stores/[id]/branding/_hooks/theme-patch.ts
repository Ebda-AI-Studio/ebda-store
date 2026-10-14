/**
 * The Branding page shows the store theme over `DEFAULT_THEME` so every
 * picker has a value, but those defaults are DISPLAY ONLY. `PUT /theme` is a
 * shallow-merge PATCH (`docs/architecture/store-theme-flags.md`): sending the
 * merged object would write every default into `stores.theme`, and on a look
 * store that buries the look's tokens under defaults (`composeStoreTheme`
 * lets `stores.theme` win) and marks every look key as "edited".
 *
 * `themePatch` returns only the keys the merchant changed on this page since
 * it loaded: a value that differs from what was shown, or `null` for a key
 * that was shown and is now gone (the theme PUT treats `null` as delete).
 */
export function themePatch<T extends object>(
  loaded: T,
  current: T
): Partial<Record<keyof T, unknown>> {
  const before = loaded as Record<string, unknown>;
  const after = current as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key];
    const now = after[key];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    patch[key] = now === undefined ? null : now;
  }
  return patch as Partial<Record<keyof T, unknown>>;
}
