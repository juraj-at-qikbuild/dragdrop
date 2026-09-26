// Server configuration from environment variables (Fly: `[env]` in fly.toml, secrets via `fly secrets set`).
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8080),
  /** comma-separated list of allowed browser origins; `*` inside an entry matches [a-z0-9-]* */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** the baked map; defaults to the repo copy in development */
  mapPath: process.env.MAP_PATH ?? path.resolve(here, '../../public/data/bratislava.json'),
  dbPath: process.env.DB_PATH ?? path.resolve(here, '../blava.db'),
  tickHz: num(process.env.TICK_HZ, 20),
  /** tick time the load governor aims to stay under (ms) */
  tickBudgetMs: num(process.env.TICK_BUDGET_MS, 12),
  /** multiplies the world-wide NPC caps (2 = twice the traffic/pedestrians; for bigger machines) */
  npcScale: num(process.env.NPC_SCALE, 1),
  /** max concurrent connected players */
  maxPlayers: num(process.env.MAX_PLAYERS, 150),
  /** bearer token for /stats (loopback requests are always allowed) */
  statsToken: process.env.STATS_TOKEN ?? '',
  /** enables test-only `debug` messages; never set in production */
  e2e: process.env.E2E === '1',
  /** optional permessage-deflate (costs CPU, saves bandwidth) */
  deflate: process.env.WS_DEFLATE === '1',
  /** Supabase project URL (Auth JWKS, PostgREST, Storage); '' disables every Supabase-backed feature */
  supabaseUrl: (process.env.SUPABASE_URL ?? process.env.GTA_BRATISKA_SUPABASE_URL ?? process.env.GTA_BRATISKA_SUPABASE_PROJECT_URL ?? '').replace(/\/+$/, ''),
  /** the `service_role`-equivalent secret key: server-only, never sent to a client, never logged */
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? process.env.GTA_BRATISKA_SUPABASE_SECRET_KEY ?? '',
  /** Cloudflare Realtime TURN credentials for voice chat; unset means STUN-only ICE */
  cfTurnKeyId: process.env.CF_TURN_KEY_ID ?? '',
  cfTurnApiToken: process.env.CF_TURN_API_TOKEN ?? '',
  /** skip Supabase JWT verification (tests, and local dev without a Supabase project) */
  authDisabled: process.env.AUTH_DISABLED === '1',
};

/** Compile the allow-list into matchers. `*` matches a single DNS label fragment (no dots). */
export function originMatcher(list: string[]) {
  const res = list.map((o) => new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*') + '$', 'i'));
  return (origin: string | undefined) => !!origin && res.some((r) => r.test(origin));
}
