// The single shared world. Owns the simulation and every connected client. Transport-agnostic:
// index.ts wraps each WebSocket in a ClientLink and forwards join/message/leave; Room never touches
// `ws` directly (docs/multiplayer.md), so tests drive it with in-memory links.
import {
  PROTOCOL_VERSION, ROSTER_ACCOUNT, ROSTER_DOWNED, ROSTER_VOICE, TICK_HZ, cleanNick, isToken,
  type ClientMsg, type FireMsg, type HelloMsg, type RosterRow, type ServerMsg, type VehFull, type WevMsg,
} from '../../src/shared/net/protocol';
import { Reader, decodeState, type StateReport } from '../../src/shared/net/codec';
import type { Level, World } from '../../src/shared/world/World';
import { Sim } from '../../src/shared/sim/Sim';
import { SimPlayer, type Profile } from '../../src/shared/sim/SimPlayer';
import { WEAPONS, WEAPON_IDS, traceMelee, type PelletReport } from '../../src/shared/sim/Combat';
import { SERVER_CAPS, type Caps } from '../../src/shared/sim/density';
import { PLAYER_SHIRTS } from '../../src/shared/entities/Ped';
import { Rng } from '../../src/shared/util/Rng';
import { dist } from '../../src/shared/util/math';
import { NetEvents } from './NetEvents';
import { ClientView, SnapshotBuilder } from './snapshot';
import { History } from './history';
import { hashToken, type Store } from './db';
import { Bucket, checkMove, plausibleHit, rewindTime, type Bounds } from './validate';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import { createFeatures, type Activity, type RemoteConfig, type RoomFeature, type Supa } from './features';
import type { AuthVerifier } from './auth-types';

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

/** a level from a client's JSON: -1 in a tunnel, 1 on a bridge deck, 2 on an upper deck, anything
 *  else the ground */
const asLevel = (l: unknown): Level => (l === 1 || l === 2 || l === -1 ? l : 0);

export interface Conn {
  link: ClientLink;
  session: Session | null;
  stateBucket: Bucket;
  /** far above any honest rate: overflowing it is flooding, and counts against the connection */
  floodBucket: Bucket;
  otherBucket: Bucket;
  strikes: number;
  strikeAt: number;
  /** an account hello is awaiting AuthVerifier.verify(): every message is ignored (not struck) until
   *  it resolves, so a slow/rejected verify can't be used to smuggle in unauthenticated traffic */
  pending: boolean;
}

/** one identity (a player key) in the world: survives reconnects within the grace period */
export class Session {
  conn: Conn | null = null;
  disconnectedAt = 0;
  view = new ClientView();
  lastPose: { x: number; y: number } | null = null;
  lastPoseAt = 0;
  lastReportAt = 0;
  wasInCar = false;
  /** the epoch lastPose belongs to: a server-side teleport (respawn) starts a new baseline */
  poseEpoch = -1;
  ack = 0;
  fireBucket: Bucket;
  hitAt = new Map<number, number>();
  constructor(
    /** the Store/`Room.sessions` key: hashToken(token) for a guest, 'acct:'+userId for an account */
    public readonly key: string,
    /** the guest token this connection presented (kept even for an account, to claim it later) */
    public token: string,
    public player: SimPlayer,
    now: number,
  ) {
    this.fireBucket = new Bucket(12, 3, now);
  }
}

export interface RoomOptions {
  world: World;
  now?: () => number;
  maxPlayers?: number;
  caps?: Caps;
  seed?: number;
  tickBudgetMs?: number;
  /** SQLite persistence (profiles, sessions, clock); none in tests unless given */
  store?: Store;
  /** wall clock for snapshot/event timestamps and hit rewinding (ms) */
  wallClock?: () => number;
  /** accept test-only `debug` messages */
  debug?: boolean;
  /** verifies a Supabase access token from hello.auth; unset: account hellos get 'auth-unavailable' */
  auth?: AuthVerifier;
  /** the shared Supabase client (server/src/supa.ts); tests inject a disabled or fake-fetch one so
   *  createFeatures() never builds its own and never touches the network */
  supa?: Supa;
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
  /** SQLite persistence (features keep their own tables there too) */
  readonly store: Store | null;
  /** test-only `debug` messages are accepted */
  readonly debug: boolean;
  /** verifies hello.auth tokens; null means account hellos get 'auth-unavailable' */
  private readonly auth: AuthVerifier | null;
  private nextLook = 0;
  private history = new History();
  private wall: () => number;
  private dirty = new Set<Session>();
  private flushTimer = 0;
  private saveTimer = 0;
  /** plug-in features (parties, voice, the daily puzzle…), see features/index.ts */
  features: RoomFeature[] = [];
  private handlers = new Map<string, (s: Session, msg: ClientMsg) => void>();
  private wevTimer = 0;
  private wevVersion = -1;
  /** set by shutdown(): everyone is already saved and the store is about to close */
  private closing = false;
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
    this.auth = opts.auth ?? null;
    this.wall = opts.wallClock ?? (() => Date.now());
    this.sim = new Sim(opts.world, { rng: new Rng(opts.seed), events: this.events, caps: opts.caps ?? SERVER_CAPS, extrapolatePlayers: true, rules: 'server' });
    // AI traffic doesn't need the 120 Hz a player's car gets on their client, and traffic nobody is
    // watching closely even less
    this.sim.physics.step_ = 1 / 60;
    this.sim.coarsePhysics = true;
    this.snaps = new SnapshotBuilder(this.sim);
    this.sim.onProfileChange = (p) => {
      const s = this.sessionOf(p);
      if (s) this.dirty.add(s);
    };
    const c = this.store?.loadClock();
    if (c) {
      this.sim.clock.setTime(c.time);
      this.sim.clock.rain = c.rain;
      this.sim.clock.wet = c.wet;
      this.sim.clock.rainTarget = c.target;
    }
    for (const f of createFeatures(this, { supa: opts.supa })) this.addFeature(f);
  }

  /** the world-event director */
  get director() {
    return this.sim.rule<WorldEvents>('worldEvents');
  }

  /** register a feature (features/index.ts does this at construction; tests and later wiring can too) */
  addFeature(f: RoomFeature) {
    this.features.push(f);
    for (const [t, h] of Object.entries(f.messages ?? {})) this.handlers.set(t, h as (s: Session, msg: ClientMsg) => void);
  }

  /** find a registered feature by id, typed (the accessors below are the common case) */
  feature<T extends RoomFeature>(id: string): T | undefined {
    return this.features.find((f) => f.id === id) as T | undefined;
  }

  get activity(): Activity | undefined {
    return this.feature<Activity>('activity');
  }

  get remoteConfig(): RemoteConfig | undefined {
    return this.feature<RemoteConfig>('remoteConfig');
  }

  /** the shared Supabase client (Activity and RemoteConfig hold the same instance) */
  get supa(): Supa | undefined {
    return this.activity?.supa ?? this.remoteConfig?.supa;
  }

  private sessionOf(p: SimPlayer) {
    for (const s of this.sessions.values()) if (s.player === p) return s;
    return undefined;
  }

  // ------------------------------------------------------------- transport
  onJoin(link: ClientLink): Conn {
    const t = this.now();
    const c: Conn = { link, session: null, stateBucket: new Bucket(40, 60, t), floodBucket: new Bucket(120, 240, t), otherBucket: new Bucket(30, 60, t), strikes: 0, strikeAt: t, pending: false };
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
    this.save([s]);
    for (const f of this.features) f.onLeave?.(s);
  }

  onMessage(c: Conn, data: string | ArrayBuffer | Uint8Array) {
    this.counters.msgsIn++;
    // an account hello is awaiting verify(): hold everything (even a repeat hello) until it resolves,
    // without striking the connection for it
    if (c.pending) return;
    const t = this.now();
    if (typeof data !== 'string') {
      const s = c.session;
      if (!s || !c.floodBucket.take(t)) return this.strike(c);
      // a burst after a stalled tab: drop the excess quietly (the next report supersedes it anyway)
      if (!c.stateBucket.take(t)) return;
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
        return this.onPunch(s, msg.target, msg.rt);
      case 'horn':
        return this.onHorn(p);
      case 'hit':
        return this.onHit(s, msg.src, msg.speed, msg.tram === 1, msg.rt);
      case 'nick': {
        const n = cleanNick(msg.nick);
        if (n) (p.nick = n), this.dirty.add(s);
        return;
      }
      case 'ping':
        if (typeof msg.ct === 'number') this.send(c, { t: 'pong', ct: msg.ct, st: this.wall() });
        return;
      case 'leave':
        this.drop(s);
        c.session = null;
        c.link.close(1000, 'leave');
        return;
      case 'debug':
        if (this.debug) this.onDebug(s, msg);
        return;
      default: {
        const h = this.handlers.get(msg.t);
        if (h) return h(s, msg);
        return this.strike(c);
      }
    }
  }

  /** misbehaving connection: drop after repeated offences (one is forgiven every 2 s, so only a burst closes it) */
  private strike(c: Conn) {
    this.counters.rejected++;
    const t = this.now();
    c.strikes = Math.max(0, c.strikes - (t - c.strikeAt) / 2000) + 1;
    c.strikeAt = t;
    if (c.strikes > 50) c.link.close(1008, 'policy');
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
    if (typeof msg.auth !== 'string') return this.accept(c, msg, hashToken(msg.token), nick, false, false);
    if (!this.auth) {
      this.send(c, { t: 'error', code: 'auth-unavailable' });
      c.link.close(4004, 'auth-unavailable');
      return;
    }
    // verifying is async (the only await in Room); hold every other message from this connection until
    // it settles (onMessage), and re-check afterwards that the connection is still the one we started with
    c.pending = true;
    this.auth.verify(msg.auth).then(
      (acct) => {
        c.pending = false;
        if (!this.conns.has(c) || c.session) return; // closed, or otherwise resolved, while we waited
        if (!acct) {
          this.send(c, { t: 'error', code: 'auth' });
          c.link.close(4005, 'auth');
          return;
        }
        const { nick: accNick, claimed } = this.accountIdentity(msg, acct);
        this.accept(c, msg, 'acct:' + acct.userId, accNick, true, claimed);
      },
      () => {
        c.pending = false;
        if (!this.conns.has(c) || c.session) return;
        this.send(c, { t: 'error', code: 'auth-unavailable' });
        c.link.close(4004, 'auth-unavailable');
      },
    );
  }

  /** where the accounts feature will reserve a unique nickname and claim guest progress (hello.claim,
   *  once, into an empty account); for now every account just keeps its hello nickname and claims nothing */
  private accountIdentity(msg: HelloMsg, _acct: { userId: string; email?: string }): { nick: string; claimed: boolean } {
    return { nick: cleanNick(msg.nick)!, claimed: false };
  }

  /** shared tail of hello(): find-or-create the session for `key` and welcome it. Used by both the
   *  synchronous guest path and the account path once its token has verified. */
  private accept(c: Conn, msg: HelloMsg, key: string, nick: string, account: boolean, claimed: boolean) {
    let s = this.sessions.get(key);
    const isNew = !s;
    const r = msg.resume;
    const resumeOk = !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && checkMove(null, r, 0, false, this.bounds) === 'ok';
    if (s) {
      // reconnect within the grace period, or the same identity in a second tab (or a second device,
      // for an account): take over
      if (s.conn) {
        this.send(s.conn, { t: 'bye', reason: 'replaced' });
        const old = s.conn;
        old.session = null;
        old.link.close(4002, 'replaced');
      }
      s.player.nick = nick;
      s.token = msg.token; // the guest token *this* connection presented (claiming reads it later)
      const p = s.player;
      const car = p.ped.vehicle;
      // the client kept playing while disconnected: take its position (movement is client-side anyway)
      if (car && (!r || r.car !== car.id)) this.sim.exitVehicle(p, true);
      if (resumeOk && p.state === 'play') {
        const v = p.ped.vehicle;
        if (v) (v.x = r!.x), (v.y = r!.y);
        p.ped.x = r!.x;
        p.ped.y = r!.y;
        p.ped.level = asLevel(r!.lvl);
      }
    } else {
      if (this.connectedCount() >= this.maxPlayers) {
        this.send(c, { t: 'error', code: 'full' });
        c.link.close(4003, 'full');
        return;
      }
      const stored = this.store?.loadProfile(key);
      const profile: Profile = stored?.profile ?? { money: 0, done: [], found: [], cumils: [], stats: {} };
      const last = this.store?.loadSession(key);
      let x: number | undefined, y: number | undefined, lvl: Level = 0;
      // where to put them: where their client says it is (reconnect after a restart), else where they
      // were when last saved, else the square
      if (r && resumeOk) (x = r.x), (y = r.y), (lvl = asLevel(r.lvl));
      else if (last) (x = last.x), (y = last.y), (lvl = last.level);
      if (x !== undefined && y !== undefined) {
        const w = this.sim.world.walkableNear(x, y);
        if (dist(w.x, w.y, x, y) > 20) x = y = undefined;
      }
      const look = this.nextLook++ % PLAYER_SHIRTS.length;
      const p = this.sim.addPlayer({ nick, look, profile, kinematic: true, x, y });
      p.ped.level = lvl;
      p.ped.levelInit = true;
      p.account = account;
      if (last) {
        p.ped.health = Math.min(100, Math.max(1, last.health));
        p.ped.armor = Math.min(100, Math.max(0, last.armor));
        p.ammo.pistol = last.ammo.pistol;
        p.ammo.uzi = last.ammo.uzi;
        p.ammo.shotgun = last.ammo.shotgun;
        p.ped.weapon = last.weapon === 'fist' || p.ammo[last.weapon] > 0 ? last.weapon : 'fist';
        p.wanted = Math.min(5, Math.max(0, last.wanted));
      }
      s = new Session(key, msg.token, p, this.now());
      this.sessions.set(key, s);
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
      car: p.ped.vehicle?.id ?? 0, epoch: p.epoch, tickHz: TICK_HZ, st: this.wall(), clock: this.clockSync(), account: p.account, claimed,
    });
    this.send(c, { t: 'profile', money: p.profile.money, found: p.profile.found, cumils: p.profile.cumils, stats: p.profile.stats });
    for (const f of this.features) f.onHello?.(s, isNew, msg);
    this.send(c, this.wevMsg());
  }

  /** the city-wide state: world events (the director) + whatever features add (the daily puzzle) */
  wevMsg(): WevMsg {
    const out: WevMsg = { t: 'wev', ev: this.director?.entries() ?? [], daily: null };
    for (const f of this.features) f.wev?.(out);
    return out;
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
    if (s.poseEpoch !== p.epoch) {
      // first report since a respawn: measure moves from where the server put them
      s.poseEpoch = p.epoch;
      s.lastPose = { x: p.ped.x, y: p.ped.y };
      s.lastPoseAt = t;
    }
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
      v.level = asLevel(veh.lvl);
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
    if (dist(m.ox, m.oy, f.x, f.y) > 4 || m.lvl !== asLevel(m.lvl)) return;
    const pellets: PelletReport[] = [];
    const rt = rewindTime(m.rt, this.wall());
    for (const pl of m.pellets) {
      if (!pl || ![pl.a, pl.hx, pl.hy].every(Number.isFinite)) return;
      if (Math.abs(Math.atan2(Math.sin(pl.a - m.a), Math.cos(pl.a - m.a))) > w.spread + 0.02) return;
      if (dist(pl.hx, pl.hy, m.ox, m.oy) > w.range + 1) return;
      let kind = pl.kind === 1 || pl.kind === 2 || pl.kind === 3 ? pl.kind : 0;
      let hit = pl.hit | 0;
      if (kind === 2 || kind === 3) {
        // check the claim against where that ped/car was when the shooter saw it
        const then = this.targetAt(hit, kind === 2, rt);
        const claim = { ox: m.ox, oy: m.oy, a: pl.a, hx: pl.hx, hy: pl.hy, range: w.range };
        if (!plausibleHit(claim, then, m.lvl, this.sim.world.raycast(m.ox, m.oy, pl.hx, pl.hy, m.lvl))) {
          this.counters.badHits++;
          kind = 0;
          hit = 0;
        }
      }
      pellets.push({ a: pl.a, kind, hit, hx: pl.hx, hy: pl.hy });
    }
    p.ammo[m.w]--;
    this.counters.shots++;
    this.sim.applyShot(p, { w: m.w, ox: m.ox, oy: m.oy, a: m.a, lvl: m.lvl, pellets });
  }

  /** where a ped (or car) was at time t, with its body radius, for validating hit claims */
  private targetAt(id: number, ped: boolean, t: number) {
    const e = ped ? this.sim.pedById(id) : this.sim.vehicleById(id);
    if (!e) return null;
    const h = this.history.at(id, t);
    if (!h) return null;
    const radius = ped ? (e as { r: number }).r + 0.15 : (e as { radius: number }).radius;
    return { ...h, radius };
  }

  private onPunch(s: Session, target: number, rt: number) {
    const p = s.player;
    const t = this.now();
    if (p.state !== 'play' || p.ped.vehicle || !s.fireBucket.take(t)) return;
    const tp = target ? this.sim.pedById(target) : null;
    if (tp) {
      // in reach (then or now), roughly in front
      const then = this.history.at(tp.id, rewindTime(rt, this.wall())) ?? tp;
      const d = Math.min(dist(then.x, then.y, p.ped.x, p.ped.y), dist(tp.x, tp.y, p.ped.x, p.ped.y));
      const a = Math.atan2(tp.y - p.ped.y, tp.x - p.ped.x);
      if (d > 1.4 + tp.r + 0.8 || tp.level !== p.ped.level || Math.abs(Math.atan2(Math.sin(a - p.ped.angle), Math.cos(a - p.ped.angle))) > 1.2) {
        this.counters.badHits++;
        return this.sim.applyMelee(p, 0);
      }
    }
    // no claim: let the server look for someone in front of them
    const hit = tp ?? traceMelee(this.sim.pedsNear(p.ped.x, p.ped.y, 3), p.ped, p.ped.angle);
    this.sim.applyMelee(p, hit?.id ?? 0);
  }

  private onHorn(p: SimPlayer) {
    const v = p.ped.vehicle;
    if (!v) return;
    this.events.horn(v.id, v.x, v.y);
    this.sim.honk(v);
  }

  /** the victim's client says a car or tram ran them over */
  private onHit(s: Session, src: number, speed: number, tram: boolean, rt: number) {
    const p = s.player;
    if (p.state !== 'play' || p.ped.vehicle || !Number.isFinite(speed)) return;
    const now = this.now();
    if (now - (s.hitAt.get(src) ?? -1e9) < 500) return;
    s.hitAt.set(src, now);
    // it must really have been there, and not slower than it moved then (plus slack)
    const then = this.history.at(src, rewindTime(rt, this.wall()));
    let sx: number, sy: number, by = 0;
    if (tram) {
      const t = this.sim.trams.find((q) => q.id === src);
      if (!t || dist(t.x, t.y, p.ped.x, p.ped.y) > 25) return this.badHit();
      (sx = t.x), (sy = t.y);
    } else {
      const v = this.sim.vehicleById(src);
      const near = (x: number, y: number) => dist(x, y, p.ped.x, p.ped.y) < v!.radius + 3;
      if (!v || !(near(v.x, v.y) || (then && near(then.x, then.y)))) return this.badHit();
      (sx = v.x), (sy = v.y), (by = v.owner);
    }
    const sp = Math.min(Math.max(speed, 0), 60, (then?.speed ?? 60) * 1.3 + 3);
    if (sp < 4) return;
    this.sim.hurtPlayer(p, tram ? sp * 5 : sp * 3, sx, sy, by);
  }

  private badHit() {
    this.counters.badHits++;
  }

  private onDebug(s: Session, m: Extract<ClientMsg, { t: 'debug' }>) {
    const p = s.player;
    if (m.give && WEAPON_IDS.includes(m.give)) (p.ammo[m.give] = 999), (p.ped.weapon = m.give);
    if (typeof m.money === 'number') p.profile.money = m.money;
    if (typeof m.wanted === 'number') this.sim.setWanted(p, m.wanted);
    if (typeof m.hp === 'number') p.ped.health = m.hp;
    if (m.event) this.director?.start(m.event);
    if (m.teleport) this.sim.teleport(p, m.teleport[0], m.teleport[1], 0);
    for (const f of this.features) f.onDebug?.(s, m);
  }

  /** remove a player for good (quit, or grace expired) */
  private drop(s: Session) {
    this.save([s]);
    for (const f of this.features) f.onDrop?.(s);
    this.sim.removePlayer(s.player);
    this.sessions.delete(s.key);
    this.dirty.delete(s);
  }

  /** write players' profiles and sessions to the database */
  private save(list: Iterable<Session>) {
    if (!this.store || this.closing) return;
    const rows = [...list].map((s) => ({ key: s.key, nick: s.player.nick, player: s.player }));
    if (!rows.length) return;
    try {
      this.store.savePlayers(rows);
    } catch (e) {
      console.error('saving players failed', e);
    }
  }

  /** flush everything (periodically, and on shutdown) */
  flush() {
    if (this.closing) return;
    this.save(this.sessions.values());
    this.dirty.clear();
    try {
      this.store?.saveClock(this.clockSync());
    } catch (e) {
      console.error('saving clock failed', e);
    }
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
    const st = this.wall();
    this.recordHistory(st);
    this.snaps.prepare(this.tickNo);
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
      const g = this.events.globals;
      if (e.length || priv.length || g.length) this.send(c, g.length ? { t: 'ev', st, e, p: priv, g } : { t: 'ev', st, e, p: priv });
    }
    this.events.clear();
    for (const f of this.features) f.tick?.(dtMs);
    // the city-wide state: every second while something is on, and soon after a change
    const dir = this.director;
    if (dir && dir.version !== this.wevVersion) this.wevTimer = Math.min(this.wevTimer, 150);
    this.wevTimer -= dtMs;
    if (this.wevTimer <= 0) {
      this.wevTimer = 1000;
      const msg = this.wevMsg();
      const changed = !!dir && dir.version !== this.wevVersion;
      if (dir) this.wevVersion = dir.version;
      if (changed || msg.ev.length || msg.daily) this.broadcast(msg);
    }

    this.rosterTimer -= dtMs;
    if (this.rosterTimer <= 0) {
      this.rosterTimer = 1000;
      const rows: RosterRow[] = [];
      for (const s of this.sessions.values()) {
        const p = s.player;
        const f = p.focus();
        const flags = (p.state === 'downed' ? ROSTER_DOWNED : 0) | (p.voiceOn ? ROSTER_VOICE : 0) | (p.account ? ROSTER_ACCOUNT : 0);
        rows.push([p.id, p.nick, Math.round(f.x), Math.round(f.y), p.stars, p.ped.vehicle ? 1 : 0, p.ped.id, p.partyId, flags]);
      }
      this.broadcast({ t: 'roster', ps: rows });
    }
    this.clockTimer -= dtMs;
    if (this.clockTimer <= 0) {
      this.clockTimer = 5000;
      this.broadcast({ t: 'clock', c: this.clockSync() });
    }
    // progress: changed profiles within a few seconds, everyone (money, position…) every 30 s
    this.flushTimer -= dtMs;
    if (this.flushTimer <= 0 && this.dirty.size) {
      this.flushTimer = 5000;
      this.save(this.dirty);
      this.dirty.clear();
    }
    this.saveTimer -= dtMs;
    if (this.saveTimer <= 0) {
      this.saveTimer = 30_000;
      this.flush();
    }
    this.tickMs = performance.now() - t0;
    this.govern(dtMs);
  }

  private recordHistory(t: number) {
    const h = this.history;
    for (const v of this.sim.vehicles) h.record(t, v.id, v.x, v.y, v.level, !v.wrecked);
    for (const p of this.sim.peds) if (!p.vehicle || p.playerId) h.record(t, p.id, p.x, p.y, p.level, !p.dead);
    for (const tr of this.sim.trams) h.record(t, tr.id, tr.x, tr.y, tr.level, true);
    h.endTick();
  }

  /** thin the city out when ticks run long (a throttled shared vCPU), fill it back when there's room */
  private govern(dtMs: number) {
    this.tickAvg += (this.tickMs - this.tickAvg) * 0.05;
    const s = dtMs / 1000;
    const sim = this.sim;
    // back off quickly when over budget (harder the further over), recover slowly
    const over = this.tickAvg / this.budget;
    if (over > 1) sim.governor = Math.max(0.2, sim.governor - Math.min(0.15, 0.04 * over) * s);
    else if (over < 0.6) sim.governor = Math.min(1, sim.governor + 0.01 * s);
  }

  /** graceful shutdown (deploy): save everyone, tell every client to reconnect shortly */
  shutdown() {
    for (const f of this.features) f.shutdown?.();
    this.flush();
    this.closing = true;
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
      ...Object.assign({}, ...this.features.map((f) => f.stats?.() ?? {})),
    };
  }

  /** to every connected player */
  broadcast(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    for (const c of this.conns) if (c.session) this.sendRaw(c, s);
  }

  /** to one player's client, if connected (features) */
  sendTo(s: Session, msg: ServerMsg) {
    if (s.conn) this.send(s.conn, msg);
  }

  /** wall clock, ms (timestamps, daily rollover) */
  wallNow() {
    return this.wall();
  }

  /** the session of a player, by player id */
  sessionById(id: number): Session | undefined {
    for (const s of this.sessions.values()) if (s.player.id === id) return s;
    return undefined;
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
