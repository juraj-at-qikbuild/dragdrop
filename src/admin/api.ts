import { AuthClient } from '@supabase/auth-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const available = !!url && !!key;
// Invitations initiated by an operator have no browser PKCE verifier. Keep this session isolated
// from the game's PKCE login, and let auth-js consume and remove the email callback fragment.
export const auth = available ? new AuthClient({
  url: url + '/auth/v1', headers: { apikey: key! }, storageKey: 'blava-city-admin-auth',
  flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true,
}) : null;

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? 'Prihlásenie vypršalo. Prihlás sa znova.' :
      status === 403 ? 'Tento účet nemá prístup do administrácie.' : 'Údaje sa nepodarilo načítať. Skús to znova.');
  }
}
export async function rpc<T>(name: string, args: object): Promise<T> {
  const { data } = await auth!.getSession();
  if (!data.session) throw new ApiError(401);
  const res = await fetch(url + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: { apikey: key!, Authorization: 'Bearer ' + data.session.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<T>;
}
export interface Totals { players: number; online: number; sessions: number; connected_ms: number; active_ms: number; measured_ms: number; }
export interface Daily { day: string; players?: number; active_ms: number; connected_ms: number; }
export interface Overview {
  registered: number; tracking_since: string | null; heartbeat: string | null; fresh: boolean; totals: Totals;
  groups: {kind: string; players: number; sessions: number; connected_ms: number; active_ms: number}[];
  daily: Daily[];
}
export interface Player {
  player: string; nick: string; email: string | null; kind: string; registered_at: string;
  last_seen: string | null; sessions: number; connected_ms: number; active_ms: number; measured_ms: number; online: boolean;
}
export interface PlayerPage { total: number; rows: Player[]; }
export interface PlayerDetail {
  player: Player | null; total: number; daily: Daily[];
  sessions: {id: string; started_at: string; last_seen: string; ended_at: string | null; connected: boolean;
    connected_ms: number; active_ms: number; measured_ms: number}[];
}
