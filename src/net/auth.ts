// Lazy Supabase Auth client for account play (docs/plans/social-events.md, Features → Accounts: guest
// or Supabase Auth). `@supabase/auth-js` (~24 KB gzipped) is imported only from inside these functions,
// so a guest — the common case — never downloads it; Vite puts it in its own chunk (verified by
// `npm run build`). VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY are read once; when either is
// unset, `authAvailable()` is false and every call below is a no-op, so play stays guest-only.
// PKCE (`flowType: 'pkce'`) keeps tokens out of the URL hash, which the game already uses for
// `#online`/`#join=`. This module holds the wire-level plumbing only; src/ui (part 2) builds the modals.
import { cleanNick } from '../shared/net/protocol';
import type { AuthError, GoTrueClient } from '@supabase/auth-js';

/** what auth-js persists here; read synchronously by hasStoredSession() without importing it */
const STORAGE_KEY = 'blava-city-auth';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export interface AuthUser {
  id: string;
  email?: string;
  nickname?: string;
}
export type AuthResult = { ok: true } | { ok: false; error: string };

/** false when the env vars are unset: every function below then no-ops and play is guest-only */
export function authAvailable(): boolean {
  return !!SUPABASE_URL && !!PUBLISHABLE_KEY;
}

/** synchronous, no auth-js import: is there a session worth trying to resume at boot? */
export function hasStoredSession(): boolean {
  if (!authAvailable()) return false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return typeof raw === 'string' && typeof (JSON.parse(raw) as { access_token?: unknown }).access_token === 'string';
  } catch {
    return false;
  }
}

let clientPromise: Promise<GoTrueClient | null> | null = null;

/** the auth-js client; created (and its chunk downloaded) on first use, then reused */
function client(): Promise<GoTrueClient | null> {
  if (!authAvailable()) return Promise.resolve(null);
  clientPromise ??= import('@supabase/auth-js').then(
    ({ AuthClient }) =>
      new AuthClient({
        url: SUPABASE_URL + '/auth/v1',
        headers: { apikey: PUBLISHABLE_KEY! }, // the publishable key goes in `apikey`, never as a Bearer token
        storageKey: STORAGE_KEY,
        flowType: 'pkce',
        detectSessionInUrl: true,
        autoRefreshToken: true,
        persistSession: true,
      }),
  );
  return clientPromise;
}

// Supabase's auth error codes (@supabase/auth-js/lib/error-codes) mapped to short Slovak copy for
// the sign-in/sign-up modal (part 2); anything else falls back to a generic message.
const AUTH_ERRORS: Record<string, string> = {
  invalid_credentials: 'Nesprávny e-mail alebo heslo.',
  email_not_confirmed: 'E-mail ešte nie je potvrdený.',
  weak_password: 'Heslo musí mať aspoň 8 znakov.',
  user_already_exists: 'Tento e-mail už je zaregistrovaný.',
  email_exists: 'Tento e-mail už je zaregistrovaný.',
  over_request_rate_limit: 'Príliš veľa pokusov, skús neskôr.',
  over_email_send_rate_limit: 'Príliš veľa pokusov, skús neskôr.',
};
const authMessage = (e: AuthError | null): string => (e && AUTH_ERRORS[e.code ?? '']) || 'Niečo sa pokazilo, skús to znova.';
const unavailable: AuthResult = { ok: false, error: 'Prihlásenie je teraz nedostupné.' };

/** a fresh access token for hello.auth; null when signed out or accounts are off. Refreshes it if
 *  the stored one is expiring, so callers can call this right before every (re)connect. */
export async function accessToken(): Promise<string | null> {
  const c = await client();
  if (!c) return null;
  const { data } = await c.getSession();
  return data.session?.access_token ?? null;
}

export async function user(): Promise<AuthUser | null> {
  const c = await client();
  if (!c) return null;
  const { data } = await c.getSession();
  const u = data.session?.user;
  if (!u) return null;
  const nickname = u.user_metadata?.nickname;
  return { id: u.id, email: u.email, nickname: typeof nickname === 'string' ? nickname : undefined };
}

export async function signUp(email: string, password: string, nickname: string): Promise<AuthResult> {
  const c = await client();
  if (!c) return unavailable;
  const nick = cleanNick(nickname);
  const { error } = await c.signUp({ email, password, options: { data: nick ? { nickname: nick } : undefined, emailRedirectTo: location.origin + location.pathname } });
  return error ? { ok: false, error: authMessage(error) } : { ok: true };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const c = await client();
  if (!c) return unavailable;
  const { error } = await c.signInWithPassword({ email, password });
  return error ? { ok: false, error: authMessage(error) } : { ok: true };
}

export async function signOut(): Promise<void> {
  // clear the local session first: auth-js's own signOut() only does this AFTER its network revoke
  // resolves, which a page navigation right after (e.g. following an account delete) could cut off
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  const c = await client();
  await c?.signOut();
}

export async function resetPassword(email: string): Promise<AuthResult> {
  const c = await client();
  if (!c) return unavailable;
  const { error } = await c.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + '?reset=1' });
  return error ? { ok: false, error: authMessage(error) } : { ok: true };
}

export async function updatePassword(password: string): Promise<AuthResult> {
  const c = await client();
  if (!c) return unavailable;
  const { error } = await c.updateUser({ password });
  return error ? { ok: false, error: authMessage(error) } : { ok: true };
}

/** the boot link `?code=…` (src/boot/links.ts `authCallback`): let auth-js finish the PKCE exchange
 *  (it also runs this on its own at construction, but we await it here to know the outcome), then
 *  scrub `code`/`reset`/error params out of the URL so a refresh doesn't replay them. */
export async function handleAuthCallback(): Promise<{ signedIn: boolean }> {
  const c = await client();
  const error = c ? (await c.initialize()).error : null;
  const url = new URL(location.href);
  for (const p of ['code', 'error', 'error_description', 'error_code', 'reset']) url.searchParams.delete(p);
  const qs = url.searchParams.toString();
  history.replaceState(null, '', url.pathname + (qs ? '?' + qs : '') + url.hash);
  if (!c || error) return { signedIn: false };
  const { data } = await c.getSession();
  return { signedIn: !!data.session };
}

// A `?reset=1` link (a password-recovery callback) also carries `?code=…`, so main.ts calls
// handleAuthCallback() for it too (to exchange the code into a session) and then flags this; part
// 2's new-password modal reads and clears it once `src/ui/kit` exists to show that modal.
let resetPending = false;
export const pendingPasswordReset = (): boolean => resetPending;
export function markPasswordResetPending() {
  resetPending = true;
}
export function clearPendingPasswordReset() {
  resetPending = false;
}
