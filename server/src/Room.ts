// The single shared world. Owns the simulation and every connected client. Transport-agnostic:
// index.ts wraps each WebSocket in a ClientLink and forwards join/message/leave; Room never touches
// `ws` directly (docs/multiplayer.md), so tests drive it with in-memory links.
import {
  PROTOCOL_VERSION, TICK_HZ, cleanNick, isToken,
  type ClientMsg, type FireMsg, type HelloMsg, type RosterRow, type ServerMsg, type VehFull,
} from '../../src/shared/net/protocol';
import { Reader, decodeState, type StateReport } from '../../src/shared/net/codec';
import type { World } from '../../src/shared/world/World';
import { Sim } from '../../src/shared/sim/Sim';
import { SimPlayer, type Profile } from '../../src/shared/sim/SimPlayer';
import { WEAPONS, WEAPON_IDS, traceMelee, type PelletReport } from '../../src/shared/sim/Combat';
import { SERVER_CAPS, type Caps } from '../../src/shared/sim/density';
import { PLAYER_SHIRTS } from '../../src/shared/entities/Ped';
import { Rng } from '../../src/shared/util/Rng';
import { dist } from '../../src/shared/util/math';
import { NetEvents } from './NetEvents';
import { ClientView, SnapshotBuilder } from './snapshot';
import { Bucket, checkMove, type Bounds } from './validate';

export interface ClientLink {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
}

/** a disconnected player's figure (and car) stays in the world this long, so a reconnect resumes */
export const GRACE_MS = 30_000;
/** a connected player that sends no state for this long stops counting as an observer */
const AFK_MS = 60_000;
/** skip sending to a client whose socket buffer is this full (slow link) */
const BACKPRESSURE_BYTES = 256 * 1024;

export interface Conn {
  link: ClientLink;
  session: Session | null;
  stateBucket: Bucket;
  otherBucket: Bucket;
  strikes: number;
}

/** one identity (token) in the world: survives reconnects within the grace period */
export class Session {
  conn: Conn | null = null;
  disconnectedAt = 0;
  view = new ClientView();
  lastPose: { x: number; y: number } | null = null;
  lastPoseAt = 0;
  lastReportAt = 0;
  wasInCar = false;
  ack = 0;
  fireBucket: Bucket;
  hitAt = new Map<number, number>();
  constructor(
    public token: string,
    public player: SimPlayer,
    now: number,
  ) {
    this.fireBucket = new Bucket(12, 3, now);
  }
}

export interface ProfileStore {
  load(token: string): { nick: string; profile: Profile } | null;
  save(token: string, nick: string, p: SimPlayer): void;
}

export interface RoomOptions {
  world: World;
  now?: () => number;
  maxPlayers?: number;
  caps?: Caps;
  seed?: number;
  tickBudgetMs?: number;
  store?: ProfileStore;
  /** accept test-only `debug` messages */
  debug?: boolean;
}

export class Room {
  sim: Sim;
  events = new NetEvents();
  sessions = new Map<string, Session>();
  private conns = new Set<Conn>();
  private snaps: SnapshotBuilder;
  private now: () => number;
  private bounds: Bounds;
  private maxPlayers: number;
  private tickNo = 0;
  private rosterTimer = 0;
  private clockTimer = 0;
  private budget: number;
  private tickAvg = 0;
  private store: ProfileStore | null;
  private debug: boolean;
  private nextLook = 0;
  counters = { bytesOut: 0, msgsIn: 0, rejected: 0, teleports: 0, shots: 0, badHits: 0 };
  tickMs = 0;

  constructor(opts: RoomOptions) {
    this.now = opts.now ?? (() => performance.now());
    const b = opts.world.bounds;
    this.bounds = { x0: b.x0 - 50, y0: b.y0 - 50, x1: b.x1 + 50, y1: b.y1 + 50 };
    this.maxPlayers = opts.maxPlayers ?? 150;
    this.budget = opts.tickBudgetMs ?? 12;
    this.store = opts.store ?? null;
    this.debug = !!opts.debug;
    this.sim = new Sim(opts.world, { rng: new Rng(opts.seed), events: this.events, caps: opts.caps ?? SERVER_CAPS, extrapolatePlayers: true });
    this.snaps = new SnapshotBuilder(this.sim);
    this.sim.onProfileChange = (p) => this.saveProfile(p);
  }

  // ------------------------------------------------------------- transport
  onJoin(link: ClientLink): Conn {
    const t = this.now();
    const c: Conn = { link, session: null, stateBucket: new Bucket(40, 60, t), otherBucket: new Bucket(30, 60, t), strikes: 0 };
    this.conns.add(c);
    return c;
  }

  onLeave(c: Conn) {
    this.conns.delete(c);
    const s = c.session;
    if (!s || s.conn !== c) return;
    s.conn = null;
    s.disconnectedAt = this.now();
    s.player.connected = false;
    // freeze the figure/car where they are
    const v = s.player.ped.vehicle;
    if (v) (v.vx = 0), (v.vy = 0), (v.av = 0);
    this.saveProfile(s.player);
  }

  onMessage(c: Conn, data: string | ArrayBuffer | Uint8Array) {
    this.counters.msgsIn++;
    const t = this.now();
    if (typeof data !== 'string') {
      const s = c.session;
      if (!s || !c.stateBucket.take(t)) return this.strike(c);
      let r: StateReport;
      try {
        r = decodeState(new Reader(data instanceof Uint8Array ? data : new Uint8Array(data)));
      } catch {
        return this.strike(c);
      }
      return this.applyReport(s, r, t);
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.strike(c);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.strike(c);
    if (!c.otherBucket.take(t)) return this.strike(c);
    if (msg.t === 'hello') return this.hello(c, msg);
    const s = c.session;
    if (!s) return this.strike(c);
    const p = s.player;
    switch (msg.t) {
      case 'enter': {
        const v = typeof msg.vid === 'number' ? this.sim.vehicleById(msg.vid) : null;
        if (!this.sim.enterVehicle(p, v, 1.5)) this.sim.events.toPlayer(p.id, { k: 'enter', vehicle: msg.vid | 0, ok: false });
        return;
      }
      case 'exit':
        return this.onExit(s, msg.x, msg.y, msg.veh);
      case 'fire':
        return this.onFire(s, msg);
      case 'punch':
        return this.onPunch(s, msg.target);
      case 'horn':
        return this.onHorn(p);
      case 'hit':
        return this.onHit(s, msg.src, msg.speed, msg.tram === 1);
      case 'nick': {
        const n = cleanNick(msg.nick);
        if (n) (p.nick = n), this.saveProfile(p);
        return;
      }
      case 'ping':
        if (typeof msg.ct === 'number') this.send(c, { t: 'pong', ct: msg.ct, st: Date.now() });
        return;
      case 'leave':
        this.drop(s);
        c.session = null;
        c.link.close(1000, 'leave');
        return;
      case 'debug':
        if (this.debug) this.onDebug(p, msg);
        return;
      default:
        return this.strike(c);
    }
  }

  /** misbehaving connection: drop after repeated offences */
  private strike(c: Conn) {
    this.counters.rejected++;
    if (++c.strikes > 50) c.link.close(1008, 'policy');
  }

  private hello(c: Conn, msg: HelloMsg) {
    if (c.session) return;
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
    let s = this.sessions.get(msg.token);
    const r = msg.resume;
    const resumeOk = !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && checkMove(null, r, 0, false, this.bounds) === 'ok';
    if (s) {
      // reconnect within the grace period, or the same identity in a second tab: take over
      if (s.conn) {
        this.send(s.conn, { t: 'bye', reason: 'replaced' });
        const old = s.conn;
        old.session = null;
        old.link.close(4002, 'replaced');
      }
      s.player.nick = nick;
      const p = s.player;
      const car = p.ped.vehicle;
      // the client kept playing while disconnected: take its position (movement is client-side anyway)
      if (car && (!r || r.car !== car.id)) this.sim.exitVehicle(p, true);
      if (resumeOk && p.state === 'play') {
        const v = p.ped.vehicle;
        if (v) (v.x = r!.x), (v.y = r!.y);
        p.ped.x = r!.x;
        p.ped.y = r!.y;
        p.ped.level = r!.lvl === 1 ? 1 : 0;
      }
    } else {
      if (this.connectedCount() >= this.maxPlayers) {
        this.send(c, { t: 'error', code: 'full' });
        c.link.close(4003, 'full');
        return;
      }
      const stored = this.store?.load(msg.token);
      const profile: Profile = stored?.profile ?? { money: 0, done: [], found: [], cumils: [] };
      let x: number | undefined, y: number | undefined;
      if (r && resumeOk) {
        const w = this.sim.world.walkableNear(r.x, r.y);
        if (dist(w.x, w.y, r.x, r.y) < 20) (x = r.x), (y = r.y);
      }
      const look = this.nextLook++ % PLAYER_SHIRTS.length;
      const p = this.sim.addPlayer({ nick, look, profile, kinematic: true, x, y });
      if (r?.lvl === 1) p.ped.level = 1;
      p.ped.levelInit = true;
      s = new Session(msg.token, p, this.now());
      this.sessions.set(msg.token, s);
      this.sim.prewarm(p);
    }
    s.conn = c;
    s.view.reset();
    s.lastReportAt = this.now();
    s.lastPose = null;
    s.player.connected = true;
    s.player.afk = false;
    c.session = s;
    const p = s.player;
    this.send(c, {
      t: 'welcome', v: PROTOCOL_VERSION, id: p.id, ped: p.ped.id, nick: p.nick, look: p.look, x: p.ped.x, y: p.ped.y, lvl: p.ped.level,
      car: p.ped.vehicle?.id ?? 0, epoch: p.epoch, tickHz: TICK_HZ, st: Date.now(), clock: this.clockSync(),
    });
    this.send(c, { t: 'profile', money: p.profile.money, found: p.profile.found, cumils: p.profile.cumils });
  }

  // ---------------------------------------------------------- player reports
  private applyReport(s: Session, r: StateReport, t: number) {
    const p = s.player;
    s.lastReportAt = t;
    p.afk = false;
    s.ack = r.seq;
    // the camera is always taken, even while dead, so the city keeps living around them
    const o = p.observer;
    o.hw = Math.min(150, Math.max(5, r.hw));
    o.hh = Math.min(150, Math.max(5, r.hh));
    if (r.epoch !== p.epoch || p.state !== 'play') return;
    const inCar = !!r.veh;
    const verdict = checkMove(s.lastPose, r, t - s.lastPoseAt, inCar || s.wasInCar, this.bounds);
    if (verdict === 'reject') return this.strike(s.conn!);
    if (verdict === 'teleport') {
      this.counters.teleports++;
      if (s.conn && s.lastPose) this.send(s.conn, { t: 'correct', x: s.lastPose.x, y: s.lastPose.y });
      return;
    }
    s.lastPose = { x: r.x, y: r.y };
    s.lastPoseAt = t;
    s.wasInCar = inCar;
    const ped = p.ped;
    ped.level = r.lvl;
    ped.levelInit = true;
    const v = ped.vehicle;
    if (r.veh && v && v.id === r.veh.vid) {
      const rv = r.veh;
      v.x = r.x;
      v.y = r.y;
      v.angle = r.a;
      v.vx = r.vx;
      v.vy = r.vy;
      v.av = rv.av;
      v.steer = rv.steer;
      v.setControls(rv.throttle, rv.steer, rv.handbrake, rv.boost);
      v.siren = rv.siren && v.kind === 'police';
      v.horn = rv.horn ? 0.3 : 0;
      v.boosting = rv.boosting;
      v.tyresBurst = rv.tyres ? 1 : 0;
      v.health = Math.min(rv.health, v.spec.health);
      v.dmg.front = rv.dmg[0];
      v.dmg.rear = rv.dmg[1];
      v.dmg.left = rv.dmg[2];
      v.dmg.right = rv.dmg[3];
      v.sinking = rv.sinking;
      v.nitro = rv.nitro;
      v.skid = rv.skid;
      v.level = r.lvl;
      v.levelInit = true;
      // the client ran the fire countdown; the server blows it up (damage, kill credit) once
      if (!v.wrecked) v.fire = rv.wrecked ? 0 : rv.fire;
      if (rv.sinking > 2.5) this.sim.wasted(p);
      ped.x = v.x;
      ped.y = v.y;
    } else if (!r.veh && !v) {
      ped.x = r.x;
      ped.y = r.y;
      ped.angle = r.a;
      ped.vx = r.vx;
      ped.vy = r.vy;
    }
    ped.weapon = r.weapon === 'fist' || p.ammo[r.weapon] > 0 ? r.weapon : 'fist';
    const f = p.focus();
    o.fx = f.x;
    o.fy = f.y;
    o.cx = f.x + r.camDx;
    o.cy = f.y + r.camDy;
  }

  private onExit(s: Session, x: number, y: number, veh: VehFull) {
    const p = s.player;
    const v = p.ped.vehicle;
    if (!v || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (veh && [veh.x, veh.y, veh.a, veh.vx, veh.vy, veh.av, veh.hp, veh.fire, veh.nitro].every(Number.isFinite) && dist(veh.x, veh.y, v.x, v.y) < 15) {
      v.x = veh.x;
      v.y = veh.y;
      v.angle = veh.a;
      v.vx = veh.vx;
      v.vy = veh.vy;
      v.av = veh.av;
      v.health = Math.min(veh.hp, v.spec.health);
      if (Array.isArray(veh.dmg) && veh.dmg.length === 4) [v.dmg.front, v.dmg.rear, v.dmg.left, v.dmg.right] = veh.dmg.map((d) => Math.max(0, Math.min(1, +d || 0)));
      if (!v.wrecked) v.fire = veh.fire;
      v.tyresBurst = veh.tyres ? 1 : 0;
      v.nitro = veh.nitro;
      v.level = veh.lvl === 1 ? 1 : 0;
    }
    const at = dist(x, y, v.x, v.y) < 6 ? { x, y } : undefined;
    this.sim.exitVehicle(p, false, at);
    s.lastPose = { x: p.ped.x, y: p.ped.y };
    s.wasInCar = true; // allow the car's last speed on the next report
  }

  /** a player's gun shot (hits as traced by their client) */
  private onFire(s: Session, m: FireMsg) {
    const p = s.player;
    const t = this.now();
    const w = WEAPONS[m.w];
    if (!w || m.w === 'fist' || p.state !== 'play' || !(p.ammo[m.w] > 0)) return;
    if (!s.fireBucket.take(t, w.cd < 0.2 ? 0.5 : 1)) return;
    if (![m.ox, m.oy, m.a].every(Number.isFinite) || !Array.isArray(m.pellets) || m.pellets.length !== w.pellets) return;
    const f = p.focus();
    if (dist(m.ox, m.oy, f.x, f.y) > 4 || (m.lvl !== 0 && m.lvl !== 1)) return;
    const pellets: PelletReport[] = [];
    for (const pl of m.pellets) {
      if (!pl || ![pl.a, pl.hx, pl.hy].every(Number.isFinite)) return;
      if (Math.abs(Math.atan2(Math.sin(pl.a - m.a), Math.cos(pl.a - m.a))) > w.spread + 0.02) return;
      if (dist(pl.hx, pl.hy, m.ox, m.oy) > w.range + 1) return;
      pellets.push({ a: pl.a, kind: pl.kind, hit: pl.hit | 0, hx: pl.hx, hy: pl.hy });
    }
    p.ammo[m.w]--;
    this.counters.shots++;
    this.sim.applyShot(p, { w: m.w, ox: m.ox, oy: m.oy, a: m.a, lvl: m.lvl, pellets });
  }

  private onPunch(s: Session, target: number) {
    const p = s.player;
    const t = this.now();
    if (p.state !== 'play' || p.ped.vehicle || !s.fireBucket.take(t)) return;
    const tp = target ? this.sim.pedById(target) : null;
    if (tp && (dist(tp.x, tp.y, p.ped.x, p.ped.y) > 3 || tp.level !== p.ped.level)) return this.sim.applyMelee(p, 0);
    // no claim: let the server look for someone in front of them
    const hit = tp ?? traceMelee(this.sim.pedsNear(p.ped.x, p.ped.y, 3), p.ped, p.ped.angle);
    this.sim.applyMelee(p, hit?.id ?? 0);
  }

  private onHorn(p: SimPlayer) {
    const v = p.ped.vehicle;
    if (!v) return;
    this.events.horn(v.id, v.x, v.y);
    for (const q of this.sim.pedsNear(v.x, v.y, 12)) if (q.kind === 'civ' && !q.vehicle && dist(q.x, q.y, v.x, v.y) < 12) this.sim.combat.scare(q, v.x, v.y);
  }

  /** the victim's client says a car or tram ran them over */
  private onHit(s: Session, src: number, speed: number, tram: boolean) {
    const p = s.player;
    if (p.state !== 'play' || p.ped.vehicle || !Number.isFinite(speed)) return;
    const now = this.now();
    if (now - (s.hitAt.get(src) ?? -1e9) < 500) return;
    s.hitAt.set(src, now);
    const sp = Math.min(Math.max(speed, 0), 60);
    let sx: number, sy: number, by = 0;
    if (tram) {
      const t = this.sim.trams.find((q) => q.id === src);
      if (!t || dist(t.x, t.y, p.ped.x, p.ped.y) > 25) return;
      (sx = t.x), (sy = t.y);
    } else {
      const v = this.sim.vehicleById(src);
      if (!v || dist(v.x, v.y, p.ped.x, p.ped.y) > 10) return;
      (sx = v.x), (sy = v.y), (by = v.owner);
    }
    this.sim.hurtPlayer(p, tram ? sp * 5 : sp * 3, sx, sy, by);
  }

  private onDebug(p: SimPlayer, m: Extract<ClientMsg, { t: 'debug' }>) {
    if (m.give && WEAPON_IDS.includes(m.give)) (p.ammo[m.give] = 999), (p.ped.weapon = m.give);
    if (typeof m.money === 'number') p.profile.money = m.money;
    if (typeof m.wanted === 'number') this.sim.setWanted(p, m.wanted);
    if (typeof m.hp === 'number') p.ped.health = m.hp;
  }

  /** remove a player for good (quit, or grace expired) */
  private drop(s: Session) {
    this.saveProfile(s.player);
    this.sim.removePlayer(s.player);
    this.sessions.delete(s.token);
  }

  private saveProfile(p: SimPlayer) {
    const s = [...this.sessions.values()].find((q) => q.player === p);
    if (s && this.store) this.store.save(s.token, p.nick, p);
  }

  connectedCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.conn) n++;
    return n;
  }

  private clockSync() {
    const c = this.sim.clock;
    return { time: +c.time.toFixed(4), rain: +c.rain.toFixed(3), wet: +c.wet.toFixed(3), target: c.rainTarget };
  }

  // ------------------------------------------------------------------ tick
  tick(dtMs: number) {
    const t0 = performance.now();
    const t = this.now();
    this.tickNo++;
    for (const s of [...this.sessions.values()]) {
      if (!s.conn && t - s.disconnectedAt > GRACE_MS) this.drop(s);
      else if (s.conn) s.player.afk = t - s.lastReportAt > AFK_MS;
    }
    this.sim.step(dtMs / 1000);
    this.snaps.prepare(this.tickNo);
    const st = Date.now();
    for (const s of this.sessions.values()) {
      const c = s.conn;
      if (!c) continue;
      if (c.link.bufferedAmount > BACKPRESSURE_BYTES) continue;
      const p = s.player;
      this.sendRaw(c, this.snaps.build(p, s.view, st, s.ack));
      const f = p.focus();
      const e = [];
      for (const ev of this.events.world) if (ev.skip !== p.id && Math.abs(ev.x - f.x) < 320 && Math.abs(ev.y - f.y) < 320) e.push(ev.e);
      const priv = this.events.takePrivate(p.id);
      if (e.length || priv.length) this.send(c, { t: 'ev', st, e, p: priv });
    }
    this.events.clear();

    this.rosterTimer -= dtMs;
    if (this.rosterTimer <= 0) {
      this.rosterTimer = 1000;
      const rows: RosterRow[] = [];
      for (const s of this.sessions.values()) {
        const p = s.player;
        const f = p.focus();
        rows.push([p.id, p.nick, Math.round(f.x), Math.round(f.y), p.stars, p.ped.vehicle ? 1 : 0, p.ped.id]);
      }
      this.broadcast({ t: 'roster', ps: rows });
    }
    this.clockTimer -= dtMs;
    if (this.clockTimer <= 0) {
      this.clockTimer = 5000;
      this.broadcast({ t: 'clock', c: this.clockSync() });
    }
    this.tickMs = performance.now() - t0;
    this.govern(dtMs);
  }

  /** thin the city out when ticks run long (a throttled shared vCPU), fill it back when there's room */
  private govern(dtMs: number) {
    this.tickAvg += (this.tickMs - this.tickAvg) * 0.05;
    const s = dtMs / 1000;
    const sim = this.sim;
    if (this.tickAvg > this.budget) sim.governor = Math.max(0.3, sim.governor - 0.02 * s);
    else if (this.tickAvg < this.budget * 0.6) sim.governor = Math.min(1, sim.governor + 0.005 * s);
  }

  /** graceful shutdown (deploy): save everyone, tell every client to reconnect shortly */
  shutdown() {
    for (const s of this.sessions.values()) this.saveProfile(s.player);
    for (const c of this.conns) {
      this.send(c, { t: 'bye', reason: 'restart' });
      c.link.close(1012, 'restart');
    }
  }

  stats() {
    const sim = this.sim;
    return {
      players: this.sessions.size, connected: this.connectedCount(), tickMs: +this.tickMs.toFixed(2), tickAvg: +this.tickAvg.toFixed(2),
      governor: +sim.governor.toFixed(2), vehicles: sim.vehicles.length, peds: sim.peds.length, trams: sim.trams.length, ids: sim.ids.size,
      snapshotBytes: this.snaps.bytes, ...this.counters,
    };
  }

  private broadcast(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    for (const c of this.conns) if (c.session) this.sendRaw(c, s);
  }

  private send(c: Conn, msg: ServerMsg) {
    this.sendRaw(c, JSON.stringify(msg));
  }

  private sendRaw(c: Conn, d: string | Uint8Array) {
    this.counters.bytesOut += typeof d === 'string' ? d.length : d.byteLength;
    try {
      c.link.send(d);
    } catch {
      /* socket closing */
    }
  }
}
