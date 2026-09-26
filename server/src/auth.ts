// Verifies a Supabase Auth access token locally against the project's JWKS, with `jose` — no network
// call per join (docs/plans/social-events.md, Features → Accounts: guest or Supabase Auth).
// The key set is fetched once at boot and refreshed every 10 min; a token with an unrecognised `kid`
// (a key rotation) forces an early refetch, throttled to at most once per 30 s so a forged/garbage
// `kid` can't be used to hammer Supabase. The last good JWKS is mirrored into SQLite (`world` key
// 'jwks') so a restart during an outage can still verify tokens signed with the previous keys.
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { AuthVerifier } from './auth-types';
import type { Store } from './db';

const REFRESH_MS = 10 * 60 * 1000;
const REFETCH_THROTTLE_MS = 30 * 1000;
const WORLD_KEY = 'jwks';
/** every JWKS fetch gives up after this long, so a stalled endpoint never stalls every account hello
 *  waiting on the shared refresh (same idea, and timeout, as supa.ts's `request()`) */
const FETCH_TIMEOUT_MS = 10_000;

/** Supabase's access-token claims beyond the standard JWT set we check */
interface SupabaseClaims extends JWTPayload {
  is_anonymous?: boolean;
  email?: string;
}

const isUnknownKid = (e: unknown) => (e as { code?: string } | null)?.code === 'ERR_JWKS_NO_MATCHING_KEY';

export interface SupabaseVerifierOptions {
  /** the Supabase project URL, no trailing slash (config.supabaseUrl) */
  url: string;
  /** persists/loads the last good JWKS, so a restart during an outage still verifies tokens; omit in tests */
  store?: Store | null;
  /** injectable for tests; defaults to fetching `${url}/auth/v1/.well-known/jwks.json` */
  fetchJwks?: () => Promise<JSONWebKeySet>;
  /** the default fetchJwks's own timeout (ms); tests shrink this instead of waiting out the real one */
  fetchTimeoutMs?: number;
}

export function createSupabaseVerifier(opts: SupabaseVerifierOptions): AuthVerifier {
  const { url, store = null } = opts;
  const issuer = url + '/auth/v1';
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const fetchJwks =
    opts.fetchJwks ??
    (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), fetchTimeoutMs);
      try {
        const res = await fetch(issuer + '/.well-known/jwks.json', { signal: ac.signal });
        if (!res.ok) throw new Error('jwks http ' + res.status);
        return (await res.json()) as JSONWebKeySet;
      } finally {
        clearTimeout(timer);
      }
    });

  let keySet: ReturnType<typeof createLocalJWKSet> | null = null;
  let lastFetchAt = 0; // 0: never (still worth trying immediately); drives the 10 min periodic refresh
  let lastKidRetryAt = -Infinity; // separate budget for unknown-`kid` refetches, so the boot fetch doesn't spend it
  let refreshing: Promise<boolean> | null = null; // in-flight fetch, shared so callers never stampede it

  // the persisted cache loads synchronously at boot, so a verify racing the first live fetch (or
  // arriving during an outage right after a restart) can still succeed against the last good keys
  if (store) {
    const cached = store.getWorld(WORLD_KEY);
    if (cached) {
      try {
        keySet = createLocalJWKSet(JSON.parse(cached) as JSONWebKeySet);
      } catch {
        /* corrupt cache: fall through to a live fetch */
      }
    }
  }

  function refresh(now: number): Promise<boolean> {
    lastFetchAt = now;
    return (refreshing ??= (async () => {
      try {
        const jwks = await fetchJwks();
        keySet = createLocalJWKSet(jwks);
        store?.setWorld(WORLD_KEY, JSON.stringify(jwks));
        return true;
      } catch (e) {
        console.error('jwks fetch failed:', (e as Error).message);
        return false;
      } finally {
        refreshing = null;
      }
    })());
  }

  void refresh(Date.now()); // boot fetch; fire-and-forget (the loaded cache above covers verifies that race it)

  async function verifyOnce(token: string, retryOnUnknownKid: boolean): Promise<{ userId: string; email?: string } | null> {
    const now = Date.now();
    if (now - lastFetchAt > REFRESH_MS) void refresh(now); // periodic refresh; this verify doesn't wait on it
    if (!keySet) {
      // never fetched (or the persisted cache was empty/corrupt): this verify has to wait for one
      if (!(await refresh(now))) throw new Error('no jwks available');
    }
    try {
      const { payload } = await jwtVerify<SupabaseClaims>(token, keySet!, { algorithms: ['ES256'], issuer, audience: 'authenticated' });
      if (payload.is_anonymous || typeof payload.sub !== 'string') return null;
      return { userId: payload.sub, email: payload.email };
    } catch (e) {
      // an unrecognised `kid` may mean the project rotated its signing keys: refetch once, throttled
      // to at most once per 30s (its own budget, so it isn't pre-spent by the unrelated boot fetch)
      if (retryOnUnknownKid && isUnknownKid(e) && now - lastKidRetryAt > REFETCH_THROTTLE_MS) {
        lastKidRetryAt = now;
        if (await refresh(now)) return verifyOnce(token, false);
      }
      return null; // expired, bad signature, wrong issuer/audience, malformed…
    }
  }

  return { verify: (token) => verifyOnce(token, true) };
}
