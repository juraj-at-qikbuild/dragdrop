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
  /** max concurrent connected players */
  maxPlayers: num(process.env.MAX_PLAYERS, 150),
  /** bearer token for /stats (loopback requests are always allowed) */
  statsToken: process.env.STATS_TOKEN ?? '',
  /** enables test-only `debug` messages; never set in production */
  e2e: process.env.E2E === '1',
  /** optional permessage-deflate (costs CPU, saves bandwidth) */
  deflate: process.env.WS_DEFLATE === '1',
};

/** Compile the allow-list into matchers. `*` matches a single DNS label fragment (no dots). */
export function originMatcher(list: string[]) {
  const res = list.map((o) => new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*') + '$', 'i'));
  return (origin: string | undefined) => !!origin && res.some((r) => r.test(origin));
}
