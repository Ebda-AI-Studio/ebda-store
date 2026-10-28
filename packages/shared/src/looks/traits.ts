/**
 * What a look decides for a trait the merchant may override (TEMPLATES-MOCK-2/-3). The editor shows this value
 * until the merchant picks one of their own (the stored key is absent), so "the look's default" is always visible
 * and a reset returns to it. `undefined` = the look has no opinion (the skin's own behaviour; the editor then
 * shows "same as the look"). Precedence everywhere else is merchant > look > skin.
 */
export function traitDefault(key: string, _lookId?: string | null): string | boolean | undefined {
  switch (key) {
    case 'headerWordmark':
      return 'lockup';
    default:
      return undefined;
  }
}
