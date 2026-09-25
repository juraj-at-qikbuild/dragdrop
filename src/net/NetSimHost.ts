// Online play: the world lives on the server. The client mirrors what the server sends (interpolated
// ~100 ms in the past), simulates only the local player's own figure and car (colliding with the
// mirrors), uploads that state 20× a second, and sends requests (enter a car, fire, …) the server grants.
import type { Game } from '../game/Game';
import type { MeView, NetView, SimHost } from '../game/SimHost';
import { Ped, setPlayerLook, type WeaponId } from '../shared/entities/Ped';
import { Vehicle } from '../shared/entities/Vehicle';
import type { Observer } from '../shared/sim/SimPlayer';
import type { ShotReport } from '../shared/sim/Combat';
import type { PrivateEvent } from '../shared/sim/events';
import { VehiclePhysics, pedContact } from '../shared/sim/Physics';
import { spikeHit } from '../shared/sim/Police';
import { Writer, Reader, decodeSnapshot, encodeState, MSG_SNAPSHOT, type Snapshot, type StateReport } from '../shared/net/codec';
import {
  INTERP_DELAY_MS, PROTOCOL_VERSION, STATE_HZ,
  type RosterRow, type ServerMsg, type VehFull, type WelcomeMsg, type WorldEvent,
} from '../shared/net/protocol';
import { Connection, type NetStatus } from './Connection';
import { Mirrors } from './Mirrors';
import type { Identity } from './identity';

export class NetSimHost implements SimHost, NetView {
  readonly mode = 'net';
  readonly allowsPause = false;
  readonly allowsTimeScale = false;
  readonly missionsEnabled = false;
  me: MeView;
  conn: Connection;
  roster: RosterRow[] = [];
  nick: string;
  private mirrors: Mirrors;
  private ownCar: Vehicle | null = null;
  private physics = new VehiclePhysics();
  private observer: Observer = { fx: 0, fy: 0, cx: 0, cy: 0, hw: 20, hh: 12 };
  private epoch = 0;
  private seq = 0;
  private sendAcc = 0;
  private writer = new Writer(128);
  private queue: { st: number; e: WorldEvent }[] = [];
  /** shots fired but not yet counted by the server: [state seq after which it's processed, weapon] */
  private pendingAmmo: { seq: number; w: WeaponId }[] = [];
  private entering = 0;
  private enteringAt = 0;
  private hitAt = new Map<number, number>();
  private started = false;

  constructor(private game: Game, url: string, private identity: Identity) {
    this.nick = identity.nick;
    const ped = new Ped('player', 0, 0, 1);
    this.me = {
      id: 0, ped, wanted: 0, state: 'play', stateTimer: 0, ammo: { fist: Infinity, pistol: 0, uzi: 0, shotgun: 0 },
      profile: { money: 0, done: [], found: [], cumils: [] }, searchZone: null, searching: false, lastCar: null,
    };
    this.mirrors = new Mirrors((id) => id === this.me.ped.id || (!!this.ownCar && id === this.ownCar.id));
    this.conn = new Connection(url, () => this.hello(), {
      welcome: (w, re) => this.onWelcome(w, re),
      message: (m) => this.onMessage(m),
      binary: (b) => this.onBinary(b),
      fatal: (r) => this.onFatal(r),
    });
  }

  /** resolves once connected; rejects if the server can't be reached */
  async start() {
    await this.conn.start();
    this.game.events.skipOwnShots = true;
  }

  get net(): NetView {
    return this;
  }
  get status(): NetStatus {
    return this.conn.status;
  }

  private hello() {
    const p = this.me.ped;
    const f = this.ownCar ?? p;
    return {
      t: 'hello' as const, v: PROTOCOL_VERSION, token: this.identity.token, nick: this.nick,
      resume: this.started ? { x: f.x, y: f.y, lvl: p.level, car: this.ownCar?.id ?? 0 } : undefined,
    };
  }

  private onWelcome(w: WelcomeMsg, reconnect: boolean) {
    const me = this.me;
    me.id = w.id;
    this.nick = w.nick;
    this.epoch = w.epoch;
    const p = me.ped;
    p.id = w.ped;
    p.playerId = w.id;
    setPlayerLook(p, w.look);
    // the server forgot what this client knew: start the mirrors over
    this.mirrors.clear();
    this.queue = [];
    this.pendingAmmo = [];
    if (this.ownCar && this.ownCar.id !== w.car) {
      // the server no longer has our car (it restarted): step out where we are
      p.vehicle = null;
      this.ownCar = null;
    }
    if (!this.started || !reconnect) {
      p.x = w.x;
      p.y = w.y;
      p.level = w.lvl;
      p.levelInit = true;
    }
    this.started = true;
    this.game.atmos.clock.sync(w.clock);
    if (reconnect) this.game.message('', 'Znovu pripojený k serveru.', 2, '#69f0ae');
  }

  private onFatal(r: 'version' | 'replaced' | 'bad-hello' | 'full') {
    const text =
      r === 'version' ? 'Nová verzia hry – obnov stránku.' : r === 'replaced' ? 'Tvoj profil hrá v inom okne.' : r === 'full' ? 'Server je plný.' : 'Server odmietol pripojenie.';
    this.game.message('Odpojený', text, 8, '#ff8a80');
  }

  private onBinary(b: ArrayBuffer) {
    const u = new Uint8Array(b);
    if (u[0] !== MSG_SNAPSHOT) return;
    let s: Snapshot;
    try {
      s = decodeSnapshot(new Reader(u));
    } catch (e) {
      console.warn('bad snapshot', e);
      return;
    }
    this.mirrors.apply(s.st, s.ents, s.gone);
    this.applyPrivate(s);
  }

  private applyPrivate(s: Snapshot) {
    const me = this.me;
    const ps = s.me;
    const p = me.ped;
    p.health = ps.health;
    p.armor = ps.armor;
    me.wanted = ps.wanted;
    me.state = ps.state;
    me.stateTimer = ps.stateTimer;
    me.searching = ps.searching;
    me.searchZone = ps.zone;
    me.profile.money = ps.money;
    if (ps.state !== 'play' && !p.dead) p.health = 0;
    // ammo: the server's count, minus shots it hasn't seen yet
    this.pendingAmmo = this.pendingAmmo.filter((q) => ((s.ack - q.seq) & 0xffff) > 0x8000);
    const pend = (w: WeaponId) => this.pendingAmmo.reduce((n, q) => n + (q.w === w ? 1 : 0), 0);
    me.ammo.pistol = Math.max(0, ps.ammo[0] - pend('pistol'));
    me.ammo.uzi = Math.max(0, ps.ammo[1] - pend('uzi'));
    me.ammo.shotgun = Math.max(0, ps.ammo[2] - pend('shotgun'));
  }

  private onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'ev':
        for (const e of m.p) this.game.events.toPlayer(this.me.id, e);
        for (const e of m.e) this.queue.push({ st: m.st, e });
        break;
      case 'roster':
        this.roster = m.ps;
        break;
      case 'clock':
        this.game.atmos.clock.sync(m.c);
        break;
      case 'profile':
        this.me.profile.money = m.money;
        this.me.profile.found = m.found;
        this.me.profile.cumils = m.cumils;
        break;
      case 'correct': {
        const p = this.me.ped;
        const v = this.ownCar;
        if (v) (v.x = m.x), (v.y = m.y), (v.vx = 0), (v.vy = 0);
        p.x = m.x;
        p.y = m.y;
        break;
      }
    }
  }

  // ------------------------------------------------------------ SimHost
  get vehicles() {
    return this.mirrors.vehicles;
  }
  get peds() {
    return this.mirrors.peds;
  }
  get trams() {
    return this.mirrors.trams;
  }
  get props() {
    return this.mirrors.props;
  }
  get helis() {
    return this.mirrors.helis;
  }
  get pickups() {
    return this.mirrors.pickups;
  }

  vehicleById(id: number) {
    if (this.ownCar && this.ownCar.id === id) return this.ownCar;
    return this.mirrors.vehicle(id);
  }
  pedById(id: number) {
    if (id === this.me.ped.id) return this.me.ped;
    return this.mirrors.pedById(id);
  }

  setObserver(o: Observer) {
    this.observer = o;
  }

  /** server time the client renders remote entities at */
  private renderTime() {
    return this.conn.serverNow() - INTERP_DELAY_MS;
  }

  update(dt: number) {
    this.conn.tick();
    const rt = this.renderTime();
    const game = this.game;
    const world = game.world;
    this.mirrors.interpolate(rt, dt, this.ownCar);
    Vehicle.env.wet = game.atmos.wet;
    const me = this.me;
    const p = me.ped;
    const car = this.ownCar;
    const ev = game.events;
    // own car against the mirrored world (mirrors are kinematic: only our car gets pushed)
    if (car) {
      this.physics.step(dt, this.vehicles, this.trams, world, {
        impact: (v, sev) => v === car && ev.crash(v.id, v.x, v.y, sev, -Math.cos(v.angle), -Math.sin(v.angle), sev > 7 ? sev : 0),
        carContact: (a, b, sev, cx, cy, nx, ny) => {
          if (a !== car && b !== car) return;
          if (sev > 4) ev.spark(cx, cy, 1);
          if (sev > 6) ev.spark(cx, cy, 2);
          if (sev > 5) ev.crash(car.id, car.x, car.y, sev, a === car ? -nx : nx, a === car ? -ny : ny, sev * 2);
        },
        tramContact: (v, _t, sev) => v === car && ev.crash(v.id, v.x, v.y, sev, 0, 0, 0),
      });
      p.x = car.x;
      p.y = car.y;
      p.level = car.level;
      for (const pr of this.mirrors.props)
        if (pr.kind === 'spike' && pr.active && !car.tyresBurst && pr.level === car.level && spikeHit(pr, car)) {
          car.tyresBurst = 1;
          game.message('', 'Klince prepichli pneumatiky!', 2.5, '#ff8a80');
        }
    } else {
      this.physics.rehash(this.vehicles);
      if (me.state === 'play') {
        // cars and trams shove us aside; a fast one runs us over: tell the server what hit us
        pedContact(p, this.physics.hash, this.trams, dt, {
          runOver: (q, v, sp) => {
            q.x += (v.vx / sp) * 1.5;
            q.y += (v.vy / sp) * 1.5;
            this.reportHit(v.id, sp, false);
          },
          tramHit: (_q, t) => this.reportHit(t.id, t.speed, true),
        });
      }
      if (!p.levelInit) (p.level = world.spawnLevel(p.x, p.y, p.r)), (p.levelInit = true);
      else world.updateLevel(p, p.vx, p.vy, p.r);
    }
    // world events, once the entities they involve have been interpolated to that moment
    if (this.queue.length) {
      let n = 0;
      while (n < this.queue.length && this.queue[n].st <= rt) this.dispatch(this.queue[n++].e);
      if (n) this.queue.splice(0, n);
    }
    if (this.entering && performance.now() - this.enteringAt > 1500) this.entering = 0;
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / STATE_HZ) {
      this.sendAcc = Math.min(this.sendAcc - 1 / STATE_HZ, 1 / STATE_HZ);
      this.sendState();
    }
  }

  private reportHit(src: number, speed: number, tram: boolean) {
    const now = performance.now();
    if (now - (this.hitAt.get(src) ?? -1e9) < 500) return;
    this.hitAt.set(src, now);
    this.conn.send({ t: 'hit', src, speed, tram: tram ? 1 : 0, rt: this.renderTime() });
  }

  private dispatch(e: WorldEvent) {
    const ev = this.game.events;
    switch (e.k) {
      case 'shot':
        ev.shot({ by: e.by, pid: e.pid, x: e.x, y: e.y, a: e.a, w: e.w, lvl: e.lvl, ends: e.ends, sparks: e.sparks });
        break;
      case 'melee':
        ev.melee(e.x, e.y, !!e.hit);
        break;
      case 'pedHit':
        ev.pedHit(e.id, e.x, e.y, e.s);
        break;
      case 'spark':
        ev.spark(e.x, e.y, e.kind);
        break;
      case 'explode':
        if (this.ownCar && e.vid === this.ownCar.id) {
          this.ownCar.wrecked = true;
          this.ownCar.fire = -1;
          this.ownCar.siren = false;
        }
        ev.explode(e.x, e.y, e.vid, e.c);
        break;
      case 'crash':
        ev.crash(e.vid, e.x, e.y, e.sev, e.nx, e.ny, e.kick);
        break;
      case 'killed':
        ev.pedKilled(e.id, e.x, e.y, e.by, e.cause);
        break;
      case 'scream':
        ev.scream(e.x, e.y);
        break;
      case 'bell':
        ev.bell(e.x, e.y);
        break;
      case 'horn':
        ev.horn(e.vid, e.x, e.y);
        break;
    }
  }

  private sendState() {
    if (!this.conn.online) return;
    const p = this.me.ped;
    const v = this.ownCar;
    const o = this.observer;
    const f = v ?? p;
    const r: StateReport = {
      seq: (this.seq = (this.seq + 1) & 0xffff), epoch: this.epoch, lvl: (v ?? p).level,
      x: f.x, y: f.y, a: v ? v.angle : p.angle, vx: v ? v.vx : p.vx, vy: v ? v.vy : p.vy, weapon: p.weapon,
      camDx: Math.max(-127, Math.min(127, o.cx - o.fx)), camDy: Math.max(-127, Math.min(127, o.cy - o.fy)), hw: o.hw, hh: o.hh,
      veh: v
        ? {
            vid: v.id, av: v.av, steer: v.steer, throttle: v.ctrl.throttle, handbrake: v.ctrl.handbrake, boost: v.ctrl.boost, siren: v.siren, horn: v.horn > 0,
            boosting: v.boosting, wrecked: v.wrecked, tyres: !!v.tyresBurst, health: Math.max(0, v.health), dmg: [v.dmg.front, v.dmg.rear, v.dmg.left, v.dmg.right],
            fire: v.fire, sinking: v.sinking, nitro: v.nitro, skid: v.skid,
          }
        : null,
    };
    encodeState(this.writer.reset(), r);
    this.conn.sendBinary(this.writer.finish());
  }

  fire(shot: ShotReport) {
    const ev = this.game.events;
    // show our own shot right away; the server's echo is skipped
    ev.shot({ by: this.me.ped.id, pid: 0, x: shot.ox, y: shot.oy, a: shot.a, w: shot.w, lvl: shot.lvl, ends: shot.pellets.flatMap((p) => [p.hx, p.hy]), sparks: shot.pellets.reduce((m, p, i) => m | (p.kind === 1 || p.kind === 3 ? 1 << i : 0), 0) });
    this.pendingAmmo.push({ seq: (this.seq + 1) & 0xffff, w: shot.w });
    this.conn.send({ t: 'fire', w: shot.w, ox: r2(shot.ox), oy: r2(shot.oy), a: r3(shot.a), lvl: shot.lvl, rt: Math.round(this.renderTime()), pellets: shot.pellets.map((p) => ({ a: r3(p.a), kind: p.kind, hit: p.hit, hx: r2(p.hx), hy: r2(p.hy) })) });
  }

  punch(target: number) {
    this.conn.send({ t: 'punch', target, rt: Math.round(this.renderTime()) });
  }

  requestEnter(v: Vehicle) {
    if (this.entering || this.ownCar) return;
    this.entering = v.id;
    this.enteringAt = performance.now();
    this.conn.send({ t: 'enter', vid: v.id });
  }

  requestExit() {
    const v = this.ownCar;
    if (!v) return;
    const p = this.me.ped;
    for (const s of [1, -1]) {
      const x = v.x + Math.sin(v.angle) * (v.spec.width / 2 + 0.7) * s;
      const y = v.y - Math.cos(v.angle) * (v.spec.width / 2 + 0.7) * s;
      if (!this.game.world.collideCircle(x, y, 0.4)) {
        p.x = x;
        p.y = y;
        break;
      }
    }
    const full: VehFull = {
      x: r2(v.x), y: r2(v.y), a: r3(v.angle), vx: r2(v.vx), vy: r2(v.vy), av: r3(v.av), hp: Math.max(0, v.health),
      dmg: [v.dmg.front, v.dmg.rear, v.dmg.left, v.dmg.right], fire: v.fire, tyres: v.tyresBurst ? 1 : 0, nitro: v.nitro, lvl: v.level,
    };
    this.conn.send({ t: 'exit', x: r2(p.x), y: r2(p.y), veh: full });
    this.releaseCar();
    this.game.audio.setStation(null);
    this.game.audio.engine(0, 0, false);
  }

  /** our car goes back to the server's control */
  private releaseCar() {
    const v = this.ownCar;
    if (!v) return;
    const p = this.me.ped;
    v.owner = 0;
    v.driver = null;
    v.setControls(0, 0, true);
    p.vehicle = null;
    p.levelInit = false;
    this.ownCar = null;
    this.mirrors.adopt(v, this.conn.serverNow());
  }

  horn() {
    if (this.ownCar) this.conn.send({ t: 'horn' });
  }

  styleCash() {
    /* combo cash is offline only */
  }

  onPrivate(e: PrivateEvent) {
    const p = this.me.ped;
    switch (e.k) {
      case 'enter': {
        this.entering = 0;
        if (!e.ok) return;
        const v = this.mirrors.release(e.vehicle);
        if (!v) return;
        v.kinematic = false;
        v.owner = this.me.id;
        v.driver = p;
        v.parked = false;
        v.levelInit = true;
        v.setControls(0, 0, false);
        p.vehicle = v;
        this.ownCar = v;
        this.me.lastCar = v;
        this.mirrors.touch();
        break;
      }
      case 'eject':
        this.releaseCar();
        p.x = e.x;
        p.y = e.y;
        break;
      case 'respawn':
        this.releaseCar();
        p.x = e.x;
        p.y = e.y;
        p.vx = p.vy = 0;
        p.state = 'walk';
        p.levelInit = false;
        this.epoch = e.epoch;
        break;
      case 'vehDamage': {
        const v = this.ownCar;
        if (!v || v.id !== e.vehicle) return;
        v.damage(e.amount);
        v.vx += e.dvx;
        v.vy += e.dvy;
        v.av += e.dav;
        break;
      }
      case 'spray': {
        const v = this.ownCar;
        if (!v || v.id !== e.vehicle) return;
        v.color = e.color;
        v.health = v.spec.health;
        v.fire = -1;
        break;
      }
      case 'found':
        if (!this.me.profile.found.includes(e.id)) this.me.profile.found.push(e.id);
        break;
      case 'cumil':
        if (!this.me.profile.cumils.includes(e.id)) this.me.profile.cumils.push(e.id);
        break;
      case 'down':
        this.me.state = e.state;
        break;
    }
  }

  persist() {
    /* the server keeps online progress */
  }

  setNick(n: string) {
    this.nick = n;
    this.identity.nick = n;
    this.conn.send({ t: 'nick', nick: n });
  }

  tagFor(playerId: number) {
    const r = this.roster.find((q) => q[0] === playerId);
    return r ? { nick: r[1], wanted: r[4] } : null;
  }

  dispose() {
    this.conn.close();
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
