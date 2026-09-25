// Load test: N bot players against a running server. Bots walk the real pedestrian graph (spread over the
// city or clustered around the main square), report their state at 20 Hz like a browser, decode every
// snapshot, and now and then shoot at a pedestrian in sight. Prints the server's /stats every 5 s
// (`bad` = hit claims the server rejected; bots aim at the latest snapshot, so a few miss).
//
//   tsx scripts/loadtest.ts --url ws://localhost:8080 --bots 100 --spread city --duration 60
//   (start the server with E2E=1 so bots can be handed a pistol; pin it with `taskset -c 0` to
//    approximate a single shared vCPU)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { World } from '../../src/shared/world/World';
import type { MapJSON } from '../../src/shared/types';
import { PROTOCOL_VERSION, type ServerMsg, type WelcomeMsg } from '../../src/shared/net/protocol';
import { Ent, Reader, Writer, decodeSnapshot, encodeState } from '../../src/shared/net/codec';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const URL_ = args.get('url') ?? 'ws://localhost:8080';
const BOTS = Number(args.get('bots') ?? 50);
const SPREAD = args.get('spread') ?? 'city';
const DURATION = Number(args.get('duration') ?? 60);
const ORIGIN = args.get('origin') ?? 'http://localhost:5173';
const HTTP = URL_.replace(/^ws/, 'http');

const world = new World(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../public/data/bratislava.json'), 'utf8')) as MapJSON);
const g = world.ped;

interface Bot {
  ws: WebSocket;
  id: number;
  x: number;
  y: number;
  a: number;
  node: number;
  target: number;
  seq: number;
  epoch: number;
  bytes: number;
  snaps: number;
  peds: Map<number, { x: number; y: number; dead: boolean }>;
  nextShot: number;
  online: boolean;
}

const bots: Bot[] = [];
const w = new Writer(128);

function spawnPoint(i: number) {
  if (SPREAD === 'cluster') {
    const m = world.landmark('main');
    return world.walkableNear(m.x + ((i * 7) % 60) - 30, m.y + ((i * 13) % 60) - 30);
  }
  const b = world.bounds;
  const x = b.x0 + 150 + ((i * 7919) % (b.x1 - b.x0 - 300));
  const y = b.y0 + 150 + ((i * 6271) % (b.y1 - b.y0 - 300));
  return world.walkableNear(x, y);
}

function connect(i: number) {
  const s = spawnPoint(i);
  const bot: Bot = {
    ws: new WebSocket(URL_, { origin: ORIGIN }), id: 0, x: s.x, y: s.y, a: 0, node: g.nearest(s.x, s.y, 200), target: -1, seq: 0, epoch: 0,
    bytes: 0, snaps: 0, peds: new Map(), nextShot: Date.now() + 3000 + Math.random() * 5000, online: false,
  };
  bot.ws.binaryType = 'arraybuffer';
  bot.ws.on('open', () => bot.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: randomUUID(), nick: `Bot ${i}`, resume: { x: s.x, y: s.y, lvl: 0, car: 0 } })));
  bot.ws.on('message', (data: ArrayBuffer | Buffer, isBinary: boolean) => {
    const len = isBinary ? (data as ArrayBuffer).byteLength : data.toString().length;
    bot.bytes += len;
    if (isBinary) {
      bot.snaps++;
      try {
        const snap = decodeSnapshot(new Reader(new Uint8Array(data as ArrayBuffer)));
        bot.epoch = snap.me.epoch;
        for (const e of snap.ents) if (e.type === Ent.Ped && !e.v.playerId) bot.peds.set(e.id, { x: e.v.x, y: e.v.y, dead: e.v.state === 'dead' });
        for (const id of snap.gone) bot.peds.delete(id);
      } catch (e) {
        console.error('bad snapshot', e);
      }
      return;
    }
    const m = JSON.parse(data.toString()) as ServerMsg;
    if (m.t === 'welcome') {
      const wm = m as WelcomeMsg;
      bot.id = wm.id;
      bot.x = wm.x;
      bot.y = wm.y;
      bot.online = true;
      bot.ws.send(JSON.stringify({ t: 'debug', give: 'pistol' }));
    } else if (m.t === 'correct') {
      bot.x = m.x;
      bot.y = m.y;
    }
  });
  bot.ws.on('error', () => {});
  bot.ws.on('close', (code, reason) => {
    if (bot.online && !finished) console.log(`bot ${i} disconnected: ${code} ${reason.toString()}`);
    bot.online = false;
  });
  bots.push(bot);
}

function step(bot: Bot, dt: number) {
  if (!bot.online) return;
  // walk the pedestrian graph at a jog
  if (bot.target < 0 || Math.hypot(g.nx(bot.target) - bot.x, g.ny(bot.target) - bot.y) < 1) {
    const out = g.out[bot.node >= 0 ? bot.node : 0];
    if (bot.target >= 0) bot.node = bot.target;
    // stay inside the playable area (a real client is held there by World.collideCircle)
    const b = world.bounds;
    const opts = (g.out[bot.node] ?? out).filter((l) => g.nx(l.to) > b.x0 + 5 && g.nx(l.to) < b.x1 - 5 && g.ny(l.to) > b.y0 + 5 && g.ny(l.to) < b.y1 - 5);
    bot.target = opts.length ? opts[Math.floor(Math.random() * opts.length)].to : bot.node;
  }
  const tx = g.nx(bot.target), ty = g.ny(bot.target);
  const d = Math.hypot(tx - bot.x, ty - bot.y) || 1;
  const sp = Math.min(5, d / dt);
  const vx = ((tx - bot.x) / d) * sp, vy = ((ty - bot.y) / d) * sp;
  bot.x += vx * dt;
  bot.y += vy * dt;
  bot.a = Math.atan2(vy, vx);
  encodeState(w.reset(), { seq: (bot.seq = (bot.seq + 1) & 0xffff), epoch: bot.epoch, lvl: 0, x: bot.x, y: bot.y, a: bot.a, vx, vy, weapon: 'pistol', camDx: 0, camDy: 0, hw: 30, hh: 18, veh: null });
  bot.ws.send(w.finish());
  // now and then, shoot the nearest pedestrian
  const now = Date.now();
  if (now > bot.nextShot) {
    bot.nextShot = now + 4000 + Math.random() * 4000;
    let best: { id: number; x: number; y: number } | null = null, bd = 25;
    for (const [id, p] of bot.peds) {
      if (p.dead || world.raycast(bot.x, bot.y, p.x, p.y) < 1) continue;
      const dd = Math.hypot(p.x - bot.x, p.y - bot.y);
      if (dd < bd && dd > 1.5) (bd = dd), (best = { id, ...p });
    }
    if (best) {
      const a = Math.atan2(best.y - bot.y, best.x - bot.x);
      const ox = bot.x + Math.cos(a) * 0.5, oy = bot.y + Math.sin(a) * 0.5;
      bot.ws.send(JSON.stringify({ t: 'fire', w: 'pistol', ox, oy, a, lvl: 0, rt: now - 120, pellets: [{ a, kind: 2, hit: best.id, hx: best.x - Math.cos(a) * 0.3, hy: best.y - Math.sin(a) * 0.3 }] }));
    }
  }
}

async function stats() {
  try {
    const s = (await (await fetch(`${HTTP}/stats`)).json()) as Record<string, number> & { loop: { avg: number; p95: number; max: number } };
    const online = bots.filter((b) => b.online).length;
    const kbs = bots.reduce((n, b) => n + b.bytes, 0) / 1024 / Math.max(1, (Date.now() - started) / 1000) / Math.max(1, online);
    console.log(
      `t=${((Date.now() - started) / 1000).toFixed(0)}s bots=${online} tick avg=${s.loop.avg} p95=${s.loop.p95} max=${s.loop.max} gov=${s.governor} ` +
        `veh=${s.vehicles} peds=${s.peds} trams=${s.trams} shots=${s.shots} bad=${s.badHits} rss=${(s.mem / 1048576).toFixed(0)}MB down=${kbs.toFixed(1)}KB/s/bot`,
    );
    return s;
  } catch (e) {
    console.log('stats unavailable', (e as Error).message);
    return null;
  }
}

const started = Date.now();
let finished = false;
for (let i = 0; i < BOTS; i++) setTimeout(() => connect(i), i * 40);
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;
  for (const b of bots) step(b, dt);
}, 50);
const statTimer = setInterval(stats, 5000);
setTimeout(async () => {
  clearInterval(timer);
  clearInterval(statTimer);
  finished = true;
  await stats();
  const snaps = bots.reduce((n, b) => n + b.snaps, 0) / Math.max(1, bots.length);
  console.log(`done: ${bots.length} bots, ${(snaps / DURATION).toFixed(1)} snapshots/s per bot`);
  for (const b of bots) b.ws.close();
  setTimeout(() => process.exit(0), 300);
}, DURATION * 1000);
