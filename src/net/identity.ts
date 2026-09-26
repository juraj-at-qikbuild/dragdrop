// Anonymous online identity: a random UUID token (a bearer secret for the online profile) plus a
// nickname, kept in localStorage. Signed-in account play (src/net/auth.ts) keeps its own session
// separately; this is only ever the guest identity, though its token is still sent even when playing
// as an account, so a guest can claim it (docs/plans/social-events.md).
import { cleanNick } from '../shared/net/protocol';

const KEY = 'blava-city-online-id';

export interface Identity {
  token: string;
  nick: string;
  /** play as the signed-in Supabase account, not the guest token above (still always sent, so it can
   *  be claimed); set by whatever boot/sign-in code constructs this Identity, not persisted here */
  account?: boolean;
}

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Identity>;
    const nick = cleanNick(v.nick);
    if (typeof v.token !== 'string' || !nick) return null;
    return { token: v.token, nick };
  } catch {
    return null;
  }
}

export function saveIdentity(id: Identity) {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    /* storage unavailable: the identity lasts for this page only */
  }
}

/** after an account delete: the next guest session (if any) must not reuse a token tied to it */
export function clearIdentity() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** sessionStorage key for a pending `#join` code (src/boot/links.ts parses the link, src/main.ts
 *  stores it): read once by NetSimHost.hello() and cleared there as soon as a session actually
 *  starts (onWelcome) — whether or not the server acted on it. */
export const JOIN_KEY = 'blava-city-join';

/** Clears a pending #join code when the join flow is abandoned before a session ever starts (the
 *  boot chooser closing without proceeding, or startOnline's final failure paths — see
 *  src/ui/AccountUi.ts and src/main.ts), so it isn't silently resent on some later, unrelated online
 *  session in the same tab. */
export function clearPendingJoin() {
  try {
    sessionStorage.removeItem(JOIN_KEY);
  } catch {
    /* ignore */
  }
}

export function newToken(): string {
  // randomUUID needs a secure context; fall back for plain-http LAN testing
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
