// Client-side copies of the server's entities. Each mirror is a real Vehicle/Ped/Tram/… instance (so the
// normal drawing code works unchanged) posed every frame from interpolated snapshots.
import { Vehicle, SPECS } from '../shared/entities/Vehicle';
import { Ped, setPlayerLook, applyAppearance } from '../shared/entities/Ped';
import { Tram } from '../shared/entities/Tram';
import { Prop } from '../shared/entities/Props';
import { Helicopter } from '../shared/entities/Helicopter';
import type { Pickup } from '../shared/sim/Pickups';
import { Ent, type EntityRec, type HeliRec, type PedRec, type PropRec, type TramRec, type VehicleRec } from '../shared/net/codec';
import { Interp } from './Interp';
import type { Level } from '../shared/world/World';

interface VehMirror {
  obj: Vehicle;
  buf: Interp;
  rec: VehicleRec;
  level: Level;
}
interface PedMirror {
  obj: Ped;
  buf: Interp;
  rec: PedRec;
  level: Level;
  lx: number;
  ly: number;
}
interface TramMirror {
  obj: Tram;
  buf: Interp;
  level: Level;
}
interface HeliMirror {
  obj: Helicopter;
  buf: Interp;
}

const VEH_F = 7; // x, y, a, vx, vy, av, steer
const PED_F = 3; // x, y, a
const TRAM_F = 10; // 3 × (x, y, a), speed
const HELI_F = 5; // x, y, a, tx, ty

export class Mirrors {
  private veh = new Map<number, VehMirror>();
  private ped = new Map<number, PedMirror>();
  private tram = new Map<number, TramMirror>();
  private pick = new Map<number, Pickup>();
  private prop = new Map<number, Prop>();
  private heli = new Map<number, HeliMirror>();
  /** entity arrays for the renderer, rebuilt when membership changes */
  vehicles: Vehicle[] = [];
  peds: Ped[] = [];
  trams: Tram[] = [];
  pickups: Pickup[] = [];
  props: Prop[] = [];
  helis: Helicopter[] = [];
  private dirty = true;
  private tmp = new Float64Array(12);

  /** ids that must never become mirrors (the local player's own figure and car) */
  constructor(private isOwn: (id: number) => boolean) {}

  vehicle(id: number) {
    return this.veh.get(id)?.obj ?? null;
  }
  pedById(id: number) {
    return this.ped.get(id)?.obj ?? null;
  }
  tramById(id: number) {
    return this.tram.get(id)?.obj ?? null;
  }

  clear() {
    this.veh.clear();
    this.ped.clear();
    this.tram.clear();
    this.pick.clear();
    this.prop.clear();
    this.heli.clear();
    this.dirty = true;
  }

  remove(id: number) {
    if (this.veh.delete(id) || this.ped.delete(id) || this.tram.delete(id) || this.pick.delete(id) || this.prop.delete(id) || this.heli.delete(id)) this.dirty = true;
  }

  /** take a vehicle out of the mirror set (the local player now drives it) */
  release(id: number): Vehicle | null {
    const m = this.veh.get(id);
    if (!m) return null;
    this.veh.delete(id);
    this.dirty = true;
    return m.obj;
  }

  /** put a vehicle the player just left back under server control, seeded so it doesn't jump */
  adopt(v: Vehicle, st: number) {
    v.kinematic = true;
    const buf = new Interp(VEH_F, [2], [[0, 3], [1, 4], [2, 5]]);
    buf.reset(st, [v.x, v.y, v.angle, v.vx, v.vy, v.av, v.steer]);
    const rec = recFromVehicle(v);
    this.veh.set(v.id, { obj: v, buf, rec, level: v.level });
    this.dirty = true;
  }

  apply(st: number, recs: EntityRec[], gone: number[]) {
    for (const id of gone) if (!this.isOwn(id)) this.remove(id);
    for (const r of recs) {
      if (this.isOwn(r.id)) continue;
      switch (r.type) {
        case Ent.Vehicle:
          this.applyVehicle(st, r.id, r.level, r.full, r.v);
          break;
        case Ent.Ped:
          this.applyPed(st, r.id, r.level, r.full, r.v);
          break;
        case Ent.Tram:
          this.applyTram(st, r.id, r.level, r.v);
          break;
        case Ent.Pickup:
          if (r.full && r.v) {
            this.dropOtherType(r.id, this.pick);
            this.pick.set(r.id, { id: r.id, x: r.v.x, y: r.v.y, kind: r.v.kind, amount: r.v.amount, respawn: 0, hidden: 0, cumil: r.v.cumil });
            this.dirty = true;
          }
          break;
        case Ent.Prop:
          this.applyProp(r.id, r.level, r.full, r.v);
          break;
        case Ent.Heli:
          this.applyHeli(st, r.id, r.full, r.v);
          break;
      }
    }
  }

  /** ids are reused across entity types after a while: forget the old kind */
  private dropOtherType(id: number, keep: Map<number, unknown>) {
    for (const m of [this.veh, this.ped, this.tram, this.pick, this.prop, this.heli] as Map<number, unknown>[])
      if (m !== keep && m.delete(id)) this.dirty = true;
  }

  private applyVehicle(st: number, id: number, level: Level, full: boolean, r: VehicleRec) {
    let m = this.veh.get(id);
    if (full && (!m || m.obj.kind !== r.kind)) {
      this.dropOtherType(id, this.veh);
      const v = new Vehicle(r.kind && r.kind in SPECS ? r.kind : 'sedan', r.x, r.y, r.a, r.color ?? '#888888');
      v.id = id;
      v.kinematic = true;
      v.levelInit = true;
      m = { obj: v, buf: new Interp(VEH_F, [2], [[0, 3], [1, 4], [2, 5]]), rec: r, level };
      this.veh.set(id, m);
      this.dirty = true;
    }
    if (!m) return;
    if (full) {
      m.obj.color = r.color ?? m.obj.color;
      m.obj.mission = !!r.mission;
      m.obj.owner = r.owner ?? 0;
    }
    m.rec = r;
    m.level = level;
    m.buf.push(st, [r.x, r.y, r.a, r.vx, r.vy, r.av, r.steer]);
  }

  private applyPed(st: number, id: number, level: Level, full: boolean, r: PedRec) {
    let m = this.ped.get(id);
    if (full && (!m || m.obj.seed !== r.seed || m.obj.kind !== r.kind)) {
      this.dropOtherType(id, this.ped);
      const p = new Ped(r.kind ?? 'civ', r.x, r.y, r.seed ?? id);
      p.id = id;
      p.kinematic = true;
      p.levelInit = true;
      p.angle = r.a;
      m = { obj: p, buf: new Interp(PED_F, [2]), rec: r, level, lx: r.x, ly: r.y };
      this.ped.set(id, m);
      this.dirty = true;
    }
    if (!m) return;
    const p = m.obj;
    if (full) {
      p.playerId = r.playerId ?? 0;
      if (p.playerId) setPlayerLook(p, r.look ?? 0);
      const outfit = r.swat ? 'swat' : p.kind === 'cop' ? 'police' : p.outfit;
      if (outfit !== p.outfit) {
        p.outfit = outfit;
        applyAppearance(p);
        if (p.playerId) setPlayerLook(p, r.look ?? 0);
      }
    }
    // keep the player-only fields: they're only present on player records
    if (!p.playerId) (r.vehicle = 0), (r.stars = 0);
    m.rec = r;
    m.level = level;
    m.buf.push(st, [r.x, r.y, r.a]);
  }

  private applyTram(st: number, id: number, level: Level, r: TramRec) {
    let m = this.tram.get(id);
    if (!m) {
      this.dropOtherType(id, this.tram);
      const t = new Tram(null, null);
      t.id = id;
      t.levelInit = true;
      m = { obj: t, buf: new Interp(TRAM_F, [2, 5, 8]), level };
      this.tram.set(id, m);
      this.dirty = true;
    }
    m.level = level;
    const s = r.sections;
    m.buf.push(st, [s[0].x, s[0].y, s[0].a, s[1].x, s[1].y, s[1].a, s[2].x, s[2].y, s[2].a, r.speed]);
  }

  private applyProp(id: number, level: Level, full: boolean, r: PropRec) {
    let p = this.prop.get(id);
    if (full) {
      this.dropOtherType(id, this.prop);
      p = new Prop(r.kind ?? 'barrier', r.x ?? 0, r.y ?? 0, r.a ?? 0, level, r.len ?? 3, 1e9);
      p.id = id;
      p.owner = r.owner ?? 0;
      this.prop.set(id, p);
      this.dirty = true;
    }
    if (p) p.active = r.active;
  }

  private applyHeli(st: number, id: number, full: boolean, r: HeliRec) {
    let m = this.heli.get(id);
    if (full && !m) {
      this.dropOtherType(id, this.heli);
      const h = new Helicopter();
      h.id = id;
      h.spawned = true;
      h.x = r.x;
      h.y = r.y;
      m = { obj: h, buf: new Interp(HELI_F, [2]) };
      this.heli.set(id, m);
      this.dirty = true;
    }
    if (!m) return;
    if (full) m.obj.targetPid = r.targetPid ?? 0;
    m.buf.push(st, [r.x, r.y, r.a, r.tx, r.ty]);
  }

  /** pose everything at render time `rt` (server clock, ms) */
  interpolate(rt: number, dt: number, ownCar: Vehicle | null) {
    const o = this.tmp;
    for (const m of this.veh.values()) {
      const v = m.obj;
      if (m.buf.sample(rt, o)) {
        v.x = o[0];
        v.y = o[1];
        v.angle = o[2];
        v.vx = o[3];
        v.vy = o[4];
        v.av = o[5];
        v.steer = o[6];
      }
      const r = m.rec;
      v.level = m.level;
      v.ctrl.throttle = r.throttle;
      v.ctrl.handbrake = r.handbrake;
      v.health = r.health * v.spec.health;
      v.dmg.front = r.dmg[0];
      v.dmg.rear = r.dmg[1];
      v.dmg.left = r.dmg[2];
      v.dmg.right = r.dmg[3];
      v.siren = r.siren;
      v.boosting = r.boosting;
      v.skid = r.skid;
      v.fire = r.burning ? 1 : -1;
      v.wrecked = r.wrecked;
      v.sinking = r.sinking;
      v.tyresBurst = r.tyres ? 1 : 0;
      v.horn = r.horn ? 0.2 : 0;
      v.parked = r.parked;
      v.driver = null;
    }
    for (const m of this.ped.values()) {
      const p = m.obj;
      const r = m.rec;
      p.level = m.level;
      p.weapon = r.weapon;
      p.handsUp = r.handsUp;
      const car = r.vehicle ? (this.veh.get(r.vehicle)?.obj ?? null) : null;
      if (r.state === 'dead' && !p.dead) {
        p.state = 'dead';
        p.deadTime = 0;
        p.vx = p.vy = 0;
      } else if (r.state !== 'dead') p.state = r.state;
      if (p.dead) p.deadTime += dt;
      p.vehicle = car;
      if (car) {
        car.driver = p;
        p.x = car.x;
        p.y = car.y;
        continue;
      }
      if (m.buf.sample(rt, o)) {
        p.x = o[0];
        p.y = o[1];
        if (!p.dead) p.angle = o[2];
      }
      if (!p.dead && dt > 0) {
        // walking animation from how far the figure moved this frame (smoothed)
        const vx = (p.x - m.lx) / dt, vy = (p.y - m.ly) / dt;
        const k = Math.min(1, dt * 12);
        p.vx += (vx - p.vx) * k;
        p.vy += (vy - p.vy) * k;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 0.1) p.walkPhase += sp * dt * 3.2;
      }
      m.lx = p.x;
      m.ly = p.y;
    }
    for (const m of this.tram.values()) {
      if (!m.buf.sample(rt, o)) continue;
      const t = m.obj;
      t.sections = [
        { x: o[0], y: o[1], a: o[2] },
        { x: o[3], y: o[4], a: o[5] },
        { x: o[6], y: o[7], a: o[8] },
      ];
      t.speed = o[9];
      t.angle = o[2];
      // Tram.x/y is the front of the tram; sections are centres
      t.x = o[0] + Math.cos(o[2]) * 4.6;
      t.y = o[1] + Math.sin(o[2]) * 4.6;
      t.level = m.level;
    }
    for (const m of this.heli.values()) {
      const h = m.obj;
      if (m.buf.sample(rt, o)) {
        h.x = o[0];
        h.y = o[1];
        h.angle = o[2];
        h.tx = o[3];
        h.ty = o[4];
      }
      h.animate(dt);
    }
    if (this.dirty) this.rebuild(ownCar);
    else if (ownCar && !this.vehicles.includes(ownCar)) this.rebuild(ownCar);
    else if (!ownCar && this.vehicles.length !== this.veh.size) this.rebuild(ownCar);
  }

  private rebuild(ownCar: Vehicle | null) {
    this.dirty = false;
    this.vehicles = [...this.veh.values()].map((m) => m.obj);
    if (ownCar) this.vehicles.push(ownCar);
    this.peds = [...this.ped.values()].map((m) => m.obj);
    this.trams = [...this.tram.values()].map((m) => m.obj);
    this.pickups = [...this.pick.values()];
    this.props = [...this.prop.values()];
    this.helis = [...this.heli.values()].map((m) => m.obj);
  }

  /** force the arrays to be rebuilt next frame (own car changed) */
  touch() {
    this.dirty = true;
  }
}

function recFromVehicle(v: Vehicle): VehicleRec {
  return {
    x: v.x, y: v.y, a: v.angle, vx: v.vx, vy: v.vy, av: v.av, steer: v.steer, throttle: 0, health: v.health / v.spec.health,
    dmg: [v.dmg.front, v.dmg.rear, v.dmg.left, v.dmg.right], siren: v.siren, boosting: false, skid: 0, burning: v.fire > 0, wrecked: v.wrecked,
    sinking: v.sinking, tyres: !!v.tyresBurst, horn: false, handbrake: true, parked: false,
  };
}
