// The single shared world. Transport-agnostic: index.ts wraps each WebSocket in a ClientLink
// and forwards join/message/leave; Room never touches `ws` directly (docs/multiplayer.md).
import {
  PROTOCOL_VERSION, TICK_HZ, cleanNick, isToken, PLAYER_SHIRTS,
  type ClientMsg, type PlayerSnap, type RosterRow, type ServerMsg, type StateMsg, type WorldEvent,
} from '../../src/shared/net/protocol';
import { SpatialHash } from '../../src/shared/util/SpatialHash';
import { Bucket, checkMove, type Bounds } from './validate';

export interface ClientLink {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
}

/** entities within this radius of a client's focus are sent to it */
export const INTEREST_R = 300;
/** ...and stay sent until they are this much further away (hysteresis) */
const INTEREST_HYST = 30;
/** a disconnected player's body stays in the world this long, so a reconnect resumes seamlessly */
export const GRACE_MS = 30_000;
/** a connected player that sends no state for this long stops counting as present */
const AFK_MS = 60_000;
/** skip sending to a client whose socket buffer is this full (slow link) */
const BACKPRESSURE_BYTES = 256 * 1024;

interface Conn {
  link: ClientLink;
  player: Player | null;
  stateBucket: Bucket;
  otherBucket: Bucket;
  strikes: number;
  openedAt: number;
}

export class Player {
  state: StateMsg | null = null;
  lastStateAt = 0;
  /** accepted teleport epoch */
  ep = -1;
  conn: Conn | null = null;
  disconnectedAt = 0;
  /** ids of other players this client currently knows about */
  known = new Set<number>();
  constructor(
    public id: number,
    public token: string,
    public nick: string,
    public look: number,
  ) {}
  get connected() {
    return this.conn !== null;
  }
}

export interface RoomOptions {
  bounds: Bounds;
  now?: () => number;
  maxPlayers?: number;
}

export class Room {
  players = new Map<number, Player>();
  private byToken = new Map<string, Player>();
  private conns = new Set<Conn>();
  private nextId = 1;
  private grid = new SpatialHash<Player>(100);
  private events: { x: number; y: number; e: WorldEvent }[] = [];
  private rosterTimer = 0;
  private now: () => number;
  private bounds: Bounds;
  private maxPlayers: number;
  /** counters for /stats */
  counters = { bytesOut: 0, msgsIn: 0, rejected: 0, teleports: 0 };
  tickMs = 0;

  constructor(opts: RoomOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.bounds = opts.bounds;
    this.maxPlayers = opts.maxPlayers ?? 150;
  }

  // ------------------------------------------------------------- transport
  onJoin(link: ClientLink): Conn {
    const t = this.now();
    const c: Conn = { link, player: null, stateBucket: new Bucket(40, 60, t), otherBucket: new Bucket(20, 40, t), strikes: 0, openedAt: t };
    this.conns.add(c);
    return c;
  }

  onLeave(c: Conn) {
    this.conns.delete(c);
    const p = c.player;
    if (!p || p.conn !== c) return;
    p.conn = null;
    p.disconnectedAt = this.now();
    if (p.state) (p.state.vx = 0), (p.state.vy = 0);
  }

  onMessage(c: Conn, data: string | ArrayBuffer | Uint8Array) {
    this.counters.msgsIn++;
    if (typeof data !== 'string') return this.strike(c); // no binary messages in protocol v1
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.strike(c);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.strike(c);
    const t = this.now();
    const bucket = msg.t === 'state' ? c.stateBucket : c.otherBucket;
    if (!bucket.take(t)) return this.strike(c);
    if (msg.t === 'hello') return this.hello(c, msg);
    const p = c.player;
    if (!p) return this.strike(c);
    switch (msg.t) {
      case 'state':
        return this.onState(p, msg, t);
      case 'shot':
        return this.onShot(p, msg);
      case 'nick': {
        const n = cleanNick(msg.nick);
        if (n) p.nick = n;
        return;
      }
      case 'ping':
        if (typeof msg.ct === 'number') this.send(c, { t: 'pong', ct: msg.ct, st: Date.now() });
        return;
      case 'leave':
        this.remove(p);
        c.player = null;
        c.link.close(1000, 'leave');
        return;
      default:
        return this.strike(c);
    }
  }

  /** misbehaving connection: drop after repeated offences */
  private strike(c: Conn) {
    if (++c.strikes > 50) c.link.close(1008, 'policy');
  }

  private hello(c: Conn, msg: Extract<ClientMsg, { t: 'hello' }>) {
    if (c.player) return;
    if (msg.v !== PROTOCOL_VERSION) {
      this.send(c, { t: 'error', code: 'version' });
      c.link.close(4000, 'version');
      return;
    }
    const nick = cleanNick(msg.nick);
    if (!isToken(msg.token) || !nick) {
      this.send(c, { t: 'error', code: 'bad-hello' });
      c.link.close(4001, 'bad-hello');
      return;
    }
    let p = this.byToken.get(msg.token);
    if (p) {
      // reconnect within the grace period, or the same identity opened a second tab: take over
      if (p.conn) {
        this.send(p.conn, { t: 'bye', reason: 'replaced' });
        const old = p.conn;
        old.player = null;
        old.link.close(4002, 'replaced');
      }
      p.nick = nick;
    } else {
      if (this.connectedCount() >= this.maxPlayers) {
        this.send(c, { t: 'error', code: 'full' });
        c.link.close(4003, 'full');
        return;
      }
      const id = this.nextId++;
      p = new Player(id, msg.token, nick, id % PLAYER_SHIRTS.length);
      this.players.set(id, p);
      this.byToken.set(msg.token, p);
    }
    p.conn = c;
    p.known.clear();
    p.lastStateAt = this.now();
    c.player = p;
    this.send(c, { t: 'welcome', v: PROTOCOL_VERSION, id: p.id, nick: p.nick, look: p.look, tickHz: TICK_HZ, st: Date.now() });
  }

  private onState(p: Player, s: StateMsg, t: number) {
    if (!validState(s)) return this.reject(p);
    const inCar = !!s.veh;
    const teleportOk = s.ep !== p.ep;
    const verdict = p.state && !teleportOk ? checkMove(p.state, s, t - p.lastStateAt, inCar || !!p.state.veh, this.bounds) : checkMove(null, s, 0, inCar, this.bounds);
    if (verdict === 'reject') return this.reject(p);
    if (verdict === 'teleport') {
      this.counters.teleports++;
      if (p.conn && p.state) this.send(p.conn, { t: 'correct', x: p.state.x, y: p.state.y });
      return;
    }
    p.ep = s.ep;
    p.state = s;
    p.lastStateAt = t;
  }

  private reject(p: Player) {
    this.counters.rejected++;
    if (p.conn) this.strike(p.conn);
  }

  private onShot(p: Player, m: Extract<ClientMsg, { t: 'shot' }>) {
    if (!p.state || !Array.isArray(m.ends) || m.ends.length > 12 || !m.ends.every(Number.isFinite)) return;
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.a)) return;
    if (Math.hypot(m.x - p.state.x, m.y - p.state.y) > 6) return;
    this.events.push({ x: m.x, y: m.y, e: { k: 'shot', pid: p.id, w: m.w, x: m.x, y: m.y, a: m.a, lvl: m.lvl === 1 ? 1 : 0, ends: m.ends } });
  }

  /** the next tick's known-vs-visible diff sends the removal to everyone who could see `p` */
  private remove(p: Player) {
    this.players.delete(p.id);
    this.byToken.delete(p.token);
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.conn) n++;
    return n;
  }

  // ------------------------------------------------------------------ tick
  tick(dtMs: number) {
    const t0 = performance.now();
    const t = this.now();
    for (const p of [...this.players.values()]) {
      if (!p.conn && t - p.disconnectedAt > GRACE_MS) this.remove(p);
    }
    this.grid.clear();
    for (const p of this.players.values()) if (p.state && (p.conn ? t - p.lastStateAt < AFK_MS : true)) this.grid.insert(p, p.state.x, p.state.y);

    const st = Date.now();
    for (const p of this.players.values()) {
      const c = p.conn;
      if (!c || !p.state) continue;
      if (c.link.bufferedAmount > BACKPRESSURE_BYTES) continue;
      const ps: PlayerSnap[] = [];
      const seen = new Set<number>();
      const { x, y } = p.state;
      this.grid.query(x, y, INTEREST_R + INTEREST_HYST, (q) => {
        if (q === p || !q.state) return;
        const d = Math.hypot(q.state.x - x, q.state.y - y);
        if (d > INTEREST_R && !(p.known.has(q.id) && d < INTEREST_R + INTEREST_HYST)) return;
        seen.add(q.id);
        ps.push(snapOf(q));
      });
      const gone: number[] = [];
      for (const id of p.known) if (!seen.has(id)) gone.push(id);
      p.known = seen;
      this.send(c, { t: 'snap', st, ps, gone });
      // world events near this client
      if (this.events.length) {
        const e = this.events.filter((ev) => Math.hypot(ev.x - x, ev.y - y) < INTEREST_R && !(ev.e.k === 'shot' && ev.e.pid === p.id)).map((ev) => ev.e);
        if (e.length) this.send(c, { t: 'ev', st, e });
      }
    }
    this.events.length = 0;

    this.rosterTimer -= dtMs;
    if (this.rosterTimer <= 0) {
      this.rosterTimer = 1000;
      const rows: RosterRow[] = [];
      for (const p of this.players.values())
        if (p.state) rows.push([p.id, p.nick, Math.round(p.state.x), Math.round(p.state.y), p.state.wanted | 0, p.state.veh ? 1 : 0]);
      const msg = JSON.stringify({ t: 'roster', ps: rows } satisfies ServerMsg);
      for (const c of this.conns) if (c.player) this.sendRaw(c, msg);
    }
    this.tickMs = performance.now() - t0;
  }

  /** graceful shutdown (deploy): tell every client to reconnect shortly */
  shutdown() {
    for (const c of this.conns) {
      this.send(c, { t: 'bye', reason: 'restart' });
      c.link.close(1012, 'restart');
    }
  }

  stats() {
    return { players: this.players.size, connected: this.connectedCount(), tickMs: +this.tickMs.toFixed(2), ...this.counters };
  }

  private send(c: Conn, msg: ServerMsg) {
    this.sendRaw(c, JSON.stringify(msg));
  }

  private sendRaw(c: Conn, s: string) {
    this.counters.bytesOut += s.length;
    try {
      c.link.send(s);
    } catch {
      /* socket closing */
    }
  }
}

function snapOf(q: Player): PlayerSnap {
  const s = q.state!;
  return { id: q.id, nick: q.nick, look: q.look, x: s.x, y: s.y, a: s.a, vx: s.vx, vy: s.vy, lvl: s.lvl, w: s.w, wanted: s.wanted, dead: s.dead, veh: s.veh };
}

const WEAPONS = new Set(['fist', 'pistol', 'uzi', 'shotgun']);
function validState(s: StateMsg): boolean {
  if (![s.x, s.y, s.a, s.vx, s.vy, s.hw, s.hh, s.wanted, s.hp, s.seq, s.ep].every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  if (!WEAPONS.has(s.w) || (s.lvl !== 0 && s.lvl !== 1)) return false;
  if (s.wanted < 0 || s.wanted > 5) return false;
  const v = s.veh;
  if (v) {
    if (typeof v.k !== 'string' || typeof v.c !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.c)) return false;
    if (![v.x, v.y, v.a, v.vx, v.vy, v.av, v.st, v.th, v.f, v.hp, v.sk, v.sink, v.fire].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
    if (!Array.isArray(v.dmg) || v.dmg.length !== 4 || !v.dmg.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  }
  return true;
}
