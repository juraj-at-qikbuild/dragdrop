// Referral links on the client (docs/referrals.md): the `#ref=` code this device arrived with (kept
// until the next online hello carries it), this player's own code (derived here exactly as the server
// derives it, so the main menu can show the link before connecting), and the stats the server last
// sent (kept, so the main menu can show them too).
import type { ReferralMsg } from '../shared/net/protocol';
import { referralCode, referralLink, referralSeed } from '../shared/referral';
import { hasStoredSession, storedUserId } from './auth';
import { loadIdentity } from './identity';

const PENDING_KEY = 'blava-city-ref';
const STATS_KEY = 'blava-city-ref-stats';
/** a `#ref=` link is remembered this long for a visitor who doesn't go online at once */
const PENDING_MS = 30 * 24 * 60 * 60 * 1000;

/** a `#ref=` link opened on this device: sent with online hellos until one is welcomed */
export function setPendingRef(code: string, now = Date.now()) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ code, at: now }));
  } catch {
    /* storage unavailable: it's only good for this page */
  }
}

export function pendingRef(now = Date.now()): string | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as { code?: unknown; at?: unknown } | null;
    if (v && typeof v.code === 'string' && typeof v.at === 'number' && now - v.at < PENDING_MS) return v.code;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** a hello with it was welcomed: the server has decided (a new player is referred, anyone else isn't) */
export function clearPendingRef() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** the server's player key for this device's online identity: the signed-in account, else the guest
 *  (hashToken(token), server/src/db.ts); null with neither */
export async function playerKey(): Promise<string | null> {
  const uid = hasStoredSession() ? storedUserId() : null;
  if (uid) return 'acct:' + uid;
  const guest = loadIdentity();
  return guest ? hex(await sha256(guest.token)) : null;
}

/** this player's own code; null without an identity, or where WebCrypto isn't available (plain-http
 *  LAN testing), where the server's `referral` message still brings it once online */
export async function myReferralCode(): Promise<string | null> {
  try {
    const key = await playerKey();
    return key ? referralCode(await sha256(referralSeed(key))) : null;
  } catch {
    return lastStats()?.code ?? null;
  }
}

/** the page's own address, for links */
export const gameBase = () => location.origin + location.pathname;

export const myReferralLink = (nick: string, code: string) => referralLink(gameBase(), nick, code);

// ------------------------------------------------------------------------ the server's latest stats
type Stats = Omit<ReferralMsg, 't'>;
let stats: Stats | null = null;
const listeners = new Set<() => void>();

/** a `referral` message (src/net/NetSimHost.ts) */
export function setReferralStats(m: ReferralMsg) {
  stats = { code: m.code, friends: m.friends, n: m.n, paid: m.paid };
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    /* ignore */
  }
  for (const f of listeners) f();
}

/** what the server said last (this page, else a previous one), or null */
export function lastStats(): Stats | null {
  if (stats) return stats;
  try {
    const v = JSON.parse(localStorage.getItem(STATS_KEY) ?? 'null') as Stats | null;
    if (v && typeof v.code === 'string' && Array.isArray(v.friends) && typeof v.n === 'number' && typeof v.paid === 'number') return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function onReferralStats(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
