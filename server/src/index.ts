// HTTP + WebSocket entry point. Serves /healthz and /stats, upgrades /ws (any path) to WebSocket
// after an Origin check, runs the fixed-rate tick loop and shuts down gracefully on SIGTERM (fly deploy).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { config, originMatcher } from './config';
import { Room } from './Room';
import { World } from '../../src/shared/world/World';
import type { MapJSON } from '../../src/shared/types';
import { Store } from './db';
import { SERVER_CAPS, scaleCaps } from '../../src/shared/sim/density';
import { createSupabaseVerifier } from './auth';

const t0 = performance.now();
const world = new World(JSON.parse(readFileSync(config.mapPath, 'utf8')) as MapJSON);
console.log(`map loaded in ${(performance.now() - t0).toFixed(0)} ms`);
const store = new Store(config.dbPath);
console.log(`database ${config.dbPath}: ${store.playerCount()} profiles`);
// never log the values themselves (config.ts), only whether each optional integration is set up
console.log(`integrations: supabase ${config.supabaseUrl && config.supabaseSecretKey ? 'yes' : 'no'}, turn ${config.cfTurnKeyId && config.cfTurnApiToken ? 'yes' : 'no'}`);
// account hellos verify a Supabase access token locally against its JWKS; unset (or AUTH_DISABLED,
// for tests/local dev without a project) means every account hello gets 'auth-unavailable'
const auth = config.supabaseUrl && !config.authDisabled ? createSupabaseVerifier({ url: config.supabaseUrl, store }) : null;
console.log(`auth: ${auth ? 'yes' : 'no'}`);
const room = new Room({
  world, store, maxPlayers: config.maxPlayers, tickBudgetMs: config.tickBudgetMs, debug: config.e2e,
  caps: scaleCaps(SERVER_CAPS, config.npcScale), auth: auth ?? undefined,
});
const originOk = originMatcher(config.allowedOrigins);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, players: room.connectedCount(), tickMs: room.tickMs }));
    return;
  }
  if (url.pathname === '/stats') {
    const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
    const auth = req.headers.authorization === `Bearer ${config.statsToken}` && config.statsToken !== '';
    if (!local && !auth) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...room.stats(), loop: loopStats(), mem: process.memoryUsage().rss }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('Blava City game server\n');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: config.deflate });

server.on('upgrade', (req, socket, head) => {
  if (!originOk(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
});

function attach(ws: WebSocket) {
  ws.binaryType = 'arraybuffer';
  const conn = room.onJoin({
    send: (d) => ws.readyState === ws.OPEN && ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
  });
  let alive = true;
  ws.on('pong', () => (alive = true));
  const hb = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 15_000);
  ws.on('message', (data, isBinary) => {
    try {
      room.onMessage(conn, isBinary ? (data as ArrayBuffer) : data.toString());
    } catch (e) {
      console.error('message handler failed', e);
    }
  });
  ws.on('close', () => {
    clearInterval(hb);
    room.onLeave(conn);
  });
  ws.on('error', () => ws.terminate());
}

// ------------------------------------------------------------- tick loop
const STEP = 1000 / config.tickHz;
let next = performance.now();
const ticks: number[] = [];
function loop() {
  const now = performance.now();
  let n = 0;
  while (now >= next && n < 3) {
    try {
      room.tick(STEP);
    } catch (e) {
      console.error('tick failed', e);
    }
    ticks.push(room.tickMs);
    if (ticks.length > 200) ticks.shift();
    next += STEP;
    n++;
  }
  if (now >= next) next = now + STEP; // fell behind: drop the backlog instead of spiralling
  setTimeout(loop, Math.max(0, next - performance.now()));
}
function loopStats() {
  const s = [...ticks].sort((a, b) => a - b);
  const q = (f: number) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(2) : 0);
  return { avg: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : 0, p95: q(0.95), max: q(1) };
}
loop();

server.listen(config.port, () => console.log(`Blava City server on :${config.port} (origins: ${config.allowedOrigins.join(', ')})`));

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: shutting down`);
  server.close();
  try {
    room.shutdown();
    store.close();
  } catch (e) {
    console.error('shutdown failed', e);
  }
  await room.supa?.shutdown(3000); // let queued activity/report rows reach Supabase before we exit
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// defence in depth: every fire-and-forget I/O path is meant to carry its own `.catch`
// (docs/plans/social-events.md), but a missed one must never take the whole process down — log the
// message only (never a value that might carry a secret) and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason instanceof Error ? reason.message : reason);
});
