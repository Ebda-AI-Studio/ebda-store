/**
 * localStorage key for the admin focus-mode state. A leaf module so both
 * `lib/auth.tsx` (clears it on logout) and `contexts/FocusModeContext.tsx`
 * (owns it) can import it without importing each other.
 */
export const FOCUS_MODE_STORAGE_KEY = 'ebda_focus_mode';
