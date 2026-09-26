// ICE servers for voice chat: public STUN always, plus Cloudflare Realtime TURN credentials when the
// server has a key (server/src/config.ts's cfTurnKeyId/cfTurnApiToken; unset means STUN-only, which
// still works between two players with a public/compatible NAT but not through symmetric NAT/CGNAT).
// docs/plans/social-events.md ("Proximity voice", Setup notes on TURN).
import type { IceServer } from '../../src/shared/net/protocol';

/** always offered, so a peer pair with reachable NATs connects even with no TURN key configured */
export const STUN_SERVERS: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];

/** Cloudflare mints credentials good for up to 24h; refresh a little early */
const CACHE_MS = 23 * 60 * 60 * 1000;

export interface TurnCacheEntry {
  servers: IceServer[];
  at: number;
}

interface CfIceResponse {
  iceServers?: IceServer[];
}

function isIceServer(v: unknown): v is IceServer {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (typeof o.urls === 'string' || (Array.isArray(o.urls) && o.urls.every((u) => typeof u === 'string')))
    && (o.username === undefined || typeof o.username === 'string')
    && (o.credential === undefined || typeof o.credential === 'string');
}

/**
 * Mints (or reuses a cached) ICE server list for one session. `cache` is owned by the caller — the
 * Voice feature keeps one Map per Room, so cached credentials never leak between Rooms/tests — and
 * `fetchImpl` is injected so tests never hit the network. Never throws: a missing key, a network
 * error, a non-2xx response or an unexpected body shape all fall back to STUN-only; only the failure
 * *kind* is logged, never the key id, token or response body (which could carry TURN credentials).
 */
export async function mintIceServers(
  keyId: string,
  apiToken: string,
  fetchImpl: typeof fetch,
  cache: Map<string, TurnCacheEntry>,
  sessionKey: string,
  now = Date.now(),
): Promise<IceServer[]> {
  const cached = cache.get(sessionKey);
  if (cached && now - cached.at < CACHE_MS) return cached.servers;
  if (!keyId || !apiToken) return STUN_SERVERS;
  try {
    const res = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!res.ok) throw new Error(`cloudflare turn: HTTP ${res.status}`);
    const body = (await res.json()) as CfIceResponse;
    if (!Array.isArray(body.iceServers) || !body.iceServers.length || !body.iceServers.every(isIceServer)) throw new Error('cloudflare turn: unexpected response shape');
    cache.set(sessionKey, { servers: body.iceServers, at: now });
    return body.iceServers;
  } catch (e) {
    console.error('cloudflare turn: mint failed, falling back to STUN-only:', e instanceof Error ? e.message : String(e));
    return STUN_SERVERS;
  }
}
