// Protocol v1 client: puts other players into the local game as kinematic mirrors (a Ped, plus a
// Vehicle while they drive), interpolated from server snapshots, and uploads the local player's state.
import type { Game } from '../game/Game';
import { Ped } from '../entities/Ped';
import { Vehicle, type VehicleKind, SPECS } from '../entities/Vehicle';
import { Connection, type NetStatus } from './Connection';
import { Interp } from './Interp';
import type { Identity } from './identity';
import {
  INTERP_DELAY_MS, PLAYER_SHIRTS, PROTOCOL_VERSION, STATE_HZ, VEH_FLAG,
  type PlayerSnap, type RosterRow, type ServerMsg, type StateMsg, type VehState, type WelcomeMsg, type WeaponId,
} from '../shared/net/protocol';

// interpolated fields: ped [x, y, a, vx, vy], vehicle [x, y, a, vx, vy, av, steer]
const PED_F = 5;
const VEH_F = 7;

interface Remote {
  id: number;
  nick: string;
  wanted: number;
  ped: Ped;
  pedBuf: Interp;
  car: Vehicle | null;
  carBuf: Interp;
  /** last full snapshot, for discrete fields */
  snap: PlayerSnap;
}

export class OnlineSession {
  conn: Connection;
  id = 0;
  nick: string;
  look = 0;
  remotes = new Map<number, Remote>();
  roster: RosterRow[] = [];
  /** teleport epoch, bumped on respawn */
  private ep = 0;
  private seq = 0;
  private sendAcc = 0;
  private tmp = new Float64Array(8);

  constructor(private game: Game, url: string, private identity: Identity) {
    this.nick = identity.nick;
    this.conn = new Connection(url, () => ({ t: 'hello', v: PROTOCOL_VERSION, token: identity.token, nick: this.nick }), {
      welcome: (w, re) => this.onWelcome(w, re),
      message: (m) => this.onMessage(m),
      fatal: (r) => this.onFatal(r),
    });
  }

  /** resolves once connected; rejects if the server can't be reached */
  async start() {
    await this.conn.start();
  }

  get status(): NetStatus {
    return this.conn.status;
  }

  private onWelcome(w: WelcomeMsg, reconnect: boolean) {
    this.id = w.id;
    this.nick = w.nick;
    this.look = w.look;
    // the server forgets what this client knew; start over so nothing lingers
    for (const r of [...this.remotes.values()]) this.dropRemote(r);
    this.sendState(true);
    if (reconnect) this.game.message('', 'Znovu pripojený k serveru.', 2, '#69f0ae');
  }

  private onFatal(r: 'version' | 'replaced' | 'bad-hello' | 'full') {
    const text =
      r === 'version' ? 'Nová verzia hry – obnov stránku.' : r === 'replaced' ? 'Tvoj profil hrá v inom okne.' : r === 'full' ? 'Server je plný.' : 'Server odmietol pripojenie.';
    this.game.message('Odpojený', text, 8, '#ff8a80');
  }

  private onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'snap':
        for (const s of m.ps) this.applySnap(m.st, s);
        for (const id of m.gone) {
          const r = this.remotes.get(id);
          if (r) this.dropRemote(r);
        }
        break;
      case 'ev':
        for (const e of m.e) if (e.k === 'shot') this.showShot(e.x, e.y, e.a, e.w, e.ends, e.pid);
        break;
      case 'roster':
        this.roster = m.ps;
        break;
      case 'correct': {
        // the server rejected a jump: go back to the last accepted position
        const p = this.game.player;
        const v = p.vehicle;
        if (v) (v.x = m.x), (v.y = m.y), (v.vx = 0), (v.vy = 0);
        p.x = m.x;
        p.y = m.y;
        break;
      }
    }
  }

  private applySnap(st: number, s: PlayerSnap) {
    let r = this.remotes.get(s.id);
    if (!r) {
      const ped = new Ped('player', s.x, s.y);
      ped.kinematic = true;
      ped.playerId = s.id;
      ped.shirt = PLAYER_SHIRTS[s.look % PLAYER_SHIRTS.length];
      ped.levelInit = true;
      r = { id: s.id, nick: s.nick, wanted: s.wanted, ped, pedBuf: new Interp(PED_F, [2], [[0, 3], [1, 4]]), car: null, carBuf: new Interp(VEH_F, [2], [[0, 3], [1, 4], [2, 5]]), snap: s };
      this.remotes.set(s.id, r);
      this.game.peds.push(ped);
    }
    r.snap = s;
    r.nick = s.nick;
    r.wanted = s.wanted;
    r.pedBuf.push(st, [s.x, s.y, s.a, s.vx, s.vy]);
    const v = s.veh;
    if (v) {
      if (!r.car || r.car.kind !== v.k) {
        if (r.car) this.removeCar(r);
        const car = new Vehicle((v.k in SPECS ? v.k : 'sedan') as VehicleKind, v.x, v.y, v.a, v.c);
        car.kinematic = true;
        car.owner = s.id;
        car.levelInit = true;
        car.driver = r.ped;
        r.car = car;
        r.carBuf.clear();
        this.game.vehicles.push(car);
      }
      r.carBuf.push(st, [v.x, v.y, v.a, v.vx, v.vy, v.av, v.st]);
    } else if (r.car) this.removeCar(r);
  }

  private removeCar(r: Remote) {
    const car = r.car!;
    this.game.vehicles = this.game.vehicles.filter((v) => v !== car);
    if (r.ped.vehicle === car) r.ped.vehicle = null;
    r.car = null;
  }

  private dropRemote(r: Remote) {
    if (r.car) this.removeCar(r);
    this.game.peds = this.game.peds.filter((p) => p !== r.ped);
    this.remotes.delete(r.id);
  }

  /** once per frame, before vehicle physics: pose every mirror at the render time */
  update(dt: number) {
    this.conn.tick();
    const rt = this.conn.serverNow() - INTERP_DELAY_MS;
    const o = this.tmp;
    for (const r of this.remotes.values()) {
      const s = r.snap;
      const p = r.ped;
      if (r.car) {
        const car = r.car;
        if (r.carBuf.sample(rt, o)) {
          car.x = o[0];
          car.y = o[1];
          car.angle = o[2];
          car.vx = o[3];
          car.vy = o[4];
          car.av = o[5];
          car.steer = o[6];
        }
        applyVehFlags(car, s.veh!);
        car.level = s.lvl;
        p.vehicle = car;
        p.x = car.x;
        p.y = car.y;
      } else {
        p.vehicle = null;
        if (r.pedBuf.sample(rt, o)) {
          p.x = o[0];
          p.y = o[1];
          p.angle = o[2];
          p.vx = o[3];
          p.vy = o[4];
          const sp = Math.hypot(p.vx, p.vy);
          if (sp > 0.1) p.walkPhase += sp * dt * 3.2;
        }
      }
      p.level = s.lvl;
      p.weapon = s.w;
      const dead = s.dead === 1;
      if (dead && !p.dead) p.kill(p.x, p.y, 0);
      else if (!dead && p.dead) (p.state = 'walk'), (p.health = 100);
    }
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / STATE_HZ) {
      this.sendAcc = Math.min(this.sendAcc - 1 / STATE_HZ, 1 / STATE_HZ);
      this.sendState(false);
    }
  }

  private sendState(force: boolean) {
    if (!this.conn.online && !force) return;
    const g = this.game;
    const p = g.player;
    const v = p.vehicle;
    const view = g.view();
    const msg: StateMsg = {
      t: 'state', seq: ++this.seq, ep: this.ep,
      x: r2(v ? v.x : p.x), y: r2(v ? v.y : p.y), a: r3(p.angle), vx: r2(p.vx), vy: r2(p.vy), lvl: p.level,
      w: p.weapon, hp: Math.round(p.health), wanted: Math.max(0, Math.ceil(g.wanted - 0.01)), dead: g.state === 'play' ? 0 : 1,
      hw: Math.round((view.x1 - view.x0) / 2), hh: Math.round((view.y1 - view.y0) / 2),
      veh: v ? vehState(v) : null,
    };
    this.conn.send(msg);
  }

  /** the local player fired: let nearby players see it */
  shot(w: WeaponId, x: number, y: number, a: number, lvl: 0 | 1, ends: number[]) {
    this.conn.send({ t: 'shot', w, x: r2(x), y: r2(y), a: r3(a), lvl, ends: ends.map(r2) });
  }

  private showShot(x: number, y: number, a: number, w: WeaponId, ends: number[], pid: number) {
    const c = this.game.combat;
    c.muzzleFlash(x + Math.cos(a) * 0.05, y + Math.sin(a) * 0.05, a);
    for (let i = 0; i + 1 < ends.length; i += 2) c.tracers.push({ x, y, x2: ends[i], y2: ends[i + 1], life: 0.06 });
    const p = this.game.player;
    this.game.audio.shot(w, Math.hypot(x - p.x, y - p.y));
    const r = this.remotes.get(pid);
    if (r) r.ped.angle = a;
  }

  /** local respawn teleports the player: tell the server it's legitimate */
  onRespawn() {
    this.ep = (this.ep + 1) & 0xff;
  }

  setNick(nick: string) {
    this.nick = nick;
    this.identity.nick = nick;
    this.conn.send({ t: 'nick', nick });
  }

  /** quit to menu */
  close() {
    this.conn.close();
    for (const r of [...this.remotes.values()]) this.dropRemote(r);
  }

  /** nick + wanted of the player a mirror ped belongs to, for name tags */
  tagFor(id: number) {
    const r = this.remotes.get(id);
    return r ? { nick: r.nick, wanted: r.wanted } : null;
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function vehState(v: Vehicle): VehState {
  let f = 0;
  if (v.siren) f |= VEH_FLAG.siren;
  if (v.ctrl.handbrake) f |= VEH_FLAG.handbrake;
  if (v.boosting) f |= VEH_FLAG.boosting;
  if (v.wrecked) f |= VEH_FLAG.wrecked;
  if (v.tyresBurst) f |= VEH_FLAG.tyres;
  if (v.horn > 0) f |= VEH_FLAG.horn;
  return {
    k: v.kind, c: v.color, x: r2(v.x), y: r2(v.y), a: r3(v.angle), vx: r2(v.vx), vy: r2(v.vy), av: r3(v.av), st: r2(v.steer), th: r2(v.ctrl.throttle), f,
    hp: Math.round(v.health), dmg: [r2(v.dmg.front), r2(v.dmg.rear), r2(v.dmg.left), r2(v.dmg.right)], sk: r2(v.skid), sink: r2(v.sinking), fire: r2(v.fire),
  };
}

function applyVehFlags(car: Vehicle, s: VehState) {
  car.siren = !!(s.f & VEH_FLAG.siren);
  car.boosting = !!(s.f & VEH_FLAG.boosting);
  car.wrecked = !!(s.f & VEH_FLAG.wrecked);
  car.tyresBurst = s.f & VEH_FLAG.tyres ? 1 : 0;
  car.horn = s.f & VEH_FLAG.horn ? 0.2 : 0;
  car.ctrl.throttle = s.th;
  car.ctrl.handbrake = !!(s.f & VEH_FLAG.handbrake);
  car.health = s.hp;
  car.dmg.front = s.dmg[0];
  car.dmg.rear = s.dmg[1];
  car.dmg.left = s.dmg[2];
  car.dmg.right = s.dmg[3];
  car.skid = s.sk;
  car.sinking = s.sink;
  car.fire = s.fire;
  car.color = s.c;
}
