'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import {
  api,
  getProfileWithMountRetries,
  hasSessionHint,
  sessionProbeSpent,
  isTransientSessionAnswer,
  type User,
} from '../lib/api';
import { isSessionIntentPath } from '../lib/session-intent';
import { useStore } from './StoreContext';
import { runPasskeyAuthentication } from '../lib/passkeys';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  /** Sign in with a passkey (Face ID, Touch ID, ...). `conditional` = the browser's autofill list. */
  loginWithPasskey: (conditional: boolean) => Promise<{ success: boolean; error?: string }>;
  register: (data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }) => Promise<{ success: boolean; verifyEmailRequired?: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // The current tenant. Customer registrations + logins must be scoped to
  // this store so a single email can belong to different accounts on
  // different storefronts (the schema's `@@unique([storeId, email])`).
  const { store } = useStore();

  // `onMount` runs the bounded retry ladder (getProfileWithMountRetries) so a
  // throttled/unreachable session check on page load does not settle the
  // customer as a guest; later explicit calls (e.g. after the profile save on
  // /account/profile) ask once.
  const checkUser = useCallback(async (onMount: boolean) => {
    // Auth is handled via HTTP-only cookies sent automatically with
    // credentials: 'include'. The cookie is scoped to the API domain
    // (api.ebda.app), so an admin signed in at
    // store.ebda.app sends the SAME cookie to /auth/me when the
    // storefront calls it — making the storefront think the admin is
    // a logged-in customer.
    //
    // Guard: only treat the response as a customer if the role is
    // explicitly 'customer'. Admin/super_admin tokens are rejected here
    // so the storefront UI never accidentally shows merchant info as
    // the customer's profile.
    try {
      const result = onMount ? await getProfileWithMountRetries() : await api.getProfile();
      if (result.success && result.data?.user && result.data.user.role === 'customer') {
        setUser(result.data.user);
      } else if (isTransientSessionAnswer(result)) {
        // A throttle, a timeout or a 5xx is not a sign-out (#1789, #2098):
        // the server could not be asked, which is unknown — never "signed
        // out". On mount the ladder above has already spent its retries with
        // `isLoading` still true; leave the existing state alone.
      } else {
        setUser(null);
      }
    } catch {
      // Unknown, not signed out — same reasoning as the transient branch.
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshUser = useCallback(() => checkUser(false), [checkUser]);

  // Console hygiene (audit 2026-11-03 #15): ask the API who this is only when it can matter.
  // A browser that holds a session hint checks on every first mount, as before. One with NO hint is
  // a guest everywhere except the account/order routes (`isSessionIntentPath`), so a visit to the
  // home page, a listing, a PDP or the blog makes no `/auth/me` call and logs no 401. It still
  // checks, once, the first time it reaches an intent route (the Safari-ITP cohort whose
  // localStorage was evicted while the refresh cookie survived is healed there, #2164).
  const pathname = usePathname();
  const intent = isSessionIntentPath(pathname);
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    // ...and only until this tab has been told "no session" once (`sessionProbeSpent`): from then on
    // a browser with no hint is a guest on the intent routes too, and repeats no 401 per page.
    if (!hasSessionHint() && (!intent || sessionProbeSpent())) {
      setIsLoading(false);
      return;
    }
    checked.current = true;
    checkUser(true);
  }, [checkUser, intent]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.login(email, password, store.id);
      if (result.success && result.data) {
        setUser(result.data.user);
        return { success: true };
      }
      return { success: false, error: result.error?.message || 'Failed to login' };
    },
    [store.id]
  );

  const loginWithPasskey = useCallback(async (conditional: boolean) => {
    const begin = await api.passkeyBegin();
    if (!begin.success || !begin.data) {
      return { success: false, error: begin.error?.code || 'PASSKEY_BEGIN_FAILED' };
    }
    // Throws NotAllowedError/AbortError when the person dismisses the prompt: the caller treats that as quiet.
    const assertion = await runPasskeyAuthentication(
      begin.data as Parameters<typeof runPasskeyAuthentication>[0],
      conditional
    );
    const result = await api.passkeyFinish(assertion);
    if (result.success && result.data && result.data.user.role === 'customer') {
      setUser(result.data.user);
      return { success: true };
    }
    return { success: false, error: result.error?.code || 'PASSKEY_AUTH_FAILED' };
  }, []);

  const register = useCallback(
    async (data: { email: string; password: string; firstName: string; lastName: string }) => {
      const result = await api.register({ ...data, storeId: store.id });
      if (!result.success) {
        return { success: false, error: result.error?.message || 'Failed to register' };
      }
      // T1-4: register no longer issues tokens. The API responds with
      // `{ emailVerificationSent: true }` for both new and existing
      // emails (closes the enumeration channel). Caller redirects to
      // a "check your email" page; the user signs in via /auth/login
      // after verifying their address.
      return { success: true, verifyEmailRequired: true };
    },
    [store.id]
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        loginWithPasskey,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

/** Like useAuth, but null outside an AuthProvider (shared PDP pieces that must also render without one). */
export function useOptionalAuth() {
  return useContext(AuthContext);
}
