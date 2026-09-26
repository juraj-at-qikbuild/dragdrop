// Binary encoding of the hot-path messages: the client's STATE (its own figure/car, 20 Hz) and the
// server's SNAPSHOT (private player state + every nearby entity that changed, every tick).
// Little-endian, quantised: positions 1/16 m in i16 (±2 km covers the map), angles u16 (or u8 for
// peds), velocities cm/s. See docs/multiplayer.md for the byte budget.
import { SPECS, type Vehicle, type VehicleKind } from '../entities/Vehicle';
import type { Ped, PedState, WeaponId } from '../entities/Ped';
import type { Tram } from '../entities/Tram';
import type { Prop, PropKind } from '../entities/Props';
import type { Helicopter } from '../entities/Helicopter';
import { PICKUP_KINDS, type Pickup, type PickupKind } from '../sim/Pickups';
import type { Level } from '../world/World';

export const MSG_SNAPSHOT = 1;
export const MSG_STATE = 2;

export const enum Ent {
  Vehicle = 0,
  Ped = 1,
  Tram = 2,
  Pickup = 3,
  Prop = 4,
  Heli = 5,
}

export const VEHICLE_KINDS = Object.keys(SPECS) as VehicleKind[];
export const WEAPON_LIST: WeaponId[] = ['fist', 'pistol', 'uzi', 'shotgun'];
const PED_STATES: PedState[] = ['walk', 'flee', 'dead', 'chase', 'idle', 'sit', 'phone', 'fight'];
const PED_KINDS = ['civ', 'cop', 'player'] as const;
const PROP_KINDS: PropKind[] = ['barrier', 'cone', 'spike'];
const TWO_PI = Math.PI * 2;
/** a level from its two wire bits: 1 on a deck, 2 (-1) in a tunnel, 3 on an upper deck (2) */
const levelOf = (bits: number): Level => ([0, 1, -1, 2] as const)[bits & 3];

// ------------------------------------------------------------------ writer/reader
export class Writer {
  buf: Uint8Array;
  private dv: DataView;
  n = 0;
  constructor(cap = 2048) {
    this.buf = new Uint8Array(cap);
    this.dv = new DataView(this.buf.buffer);
  }
  reset() {
    this.n = 0;
    return this;
  }
  private need(k: number) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(v: number) {
    this.need(1);
    this.dv.setUint8(this.n, v);
    this.n += 1;
  }
  i8(v: number) {
    this.need(1);
    this.dv.setInt8(this.n, clampInt(v, -128, 127));
    this.n += 1;
  }
  u16(v: number) {
    this.need(2);
    this.dv.setUint16(this.n, clampInt(v, 0, 65535), true);
    this.n += 2;
  }
  i16(v: number) {
    this.need(2);
    this.dv.setInt16(this.n, clampInt(v, -32768, 32767), true);
    this.n += 2;
  }
  u32(v: number) {
    this.need(4);
    this.dv.setUint32(this.n, v >>> 0, true);
    this.n += 4;
  }
  f64(v: number) {
    this.need(8);
    this.dv.setFloat64(this.n, v, true);
    this.n += 8;
  }
  bytes(b: Uint8Array) {
    this.need(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  /** position: 1/16 m */
  pos(m: number) {
    this.i16(Math.round(m * 16));
  }
  /** velocity: cm/s */
  vel(v: number) {
    this.i16(Math.round(v * 100));
  }
  ang16(a: number) {
    this.u16(Math.round((((a % TWO_PI) + TWO_PI) % TWO_PI) / TWO_PI * 65536) & 0xffff);
  }
  ang8(a: number) {
    this.u8(Math.round((((a % TWO_PI) + TWO_PI) % TWO_PI) / TWO_PI * 256) & 0xff);
  }
  /** overwrite a u16 written earlier (counts known only at the end) */
  patchU16(at: number, v: number) {
    this.dv.setUint16(at, v, true);
  }
  /** a copy of what was written */
  finish(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
  /** FNV-1a over bytes [from, n) (change detection) */
  hash(from: number) {
    let h = 0x811c9dc5;
    for (let i = from; i < this.n; i++) h = Math.imul(h ^ this.buf[i], 16777619);
    return h >>> 0;
  }
}

export class Reader {
  private dv: DataView;
  n = 0;
  constructor(buf: ArrayBuffer | Uint8Array) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  }
  get left() {
    return this.dv.byteLength - this.n;
  }
  private take(k: number) {
    if (this.n + k > this.dv.byteLength) throw new RangeError('truncated message');
    const at = this.n;
    this.n += k;
    return at;
  }
  u8() {
    return this.dv.getUint8(this.take(1));
  }
  i8() {
    return this.dv.getInt8(this.take(1));
  }
  u16() {
    return this.dv.getUint16(this.take(2), true);
  }
  i16() {
    return this.dv.getInt16(this.take(2), true);
  }
  u32() {
    return this.dv.getUint32(this.take(4), true);
  }
  f64() {
    return this.dv.getFloat64(this.take(8), true);
  }
  pos() {
    return this.i16() / 16;
  }
  vel() {
    return this.i16() / 100;
  }
  ang16() {
    const a = (this.u16() / 65536) * TWO_PI;
    return a > Math.PI ? a - TWO_PI : a;
  }
  ang8() {
    const a = (this.u8() / 256) * TWO_PI;
    return a > Math.PI ? a - TWO_PI : a;
  }
}

function clampInt(v: number, a: number, b: number) {
  v = Math.round(v);
  return v < a ? a : v > b ? b : Number.isFinite(v) ? v : 0;
}

const packDmg = (d: { front: number; rear: number; left: number; right: number }) =>
  (q4(d.front) << 12) | (q4(d.rear) << 8) | (q4(d.left) << 4) | q4(d.right);
const q4 = (v: number) => clampInt(v * 15, 0, 15);
const unpackDmg = (v: number): [number, number, number, number] => [((v >> 12) & 15) / 15, ((v >> 8) & 15) / 15, ((v >> 4) & 15) / 15, (v & 15) / 15];

// ------------------------------------------------------------------- client STATE
export interface VehReport {
  vid: number;
  av: number;
  steer: number;
  throttle: number;
  handbrake: boolean;
  boost: boolean;
  siren: boolean;
  horn: boolean;
  boosting: boolean;
  wrecked: boolean;
  tyres: boolean;
  health: number;
  dmg: [number, number, number, number];
  fire: number;
  sinking: number;
  nitro: number;
  skid: number;
}

export interface StateReport {
  seq: number;
  epoch: number;
  lvl: Level;
  /** the figure's pose, or the car's while driving */
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  weapon: WeaponId;
  /** camera centre relative to the focus (m) and half extents (m) */
  camDx: number;
  camDy: number;
  hw: number;
  hh: number;
  veh: VehReport | null;
}

export function encodeState(w: Writer, s: StateReport) {
  w.u8(MSG_STATE);
  w.u16(s.seq & 0xffff);
  w.u8(s.epoch & 0xff);
  // flags: driving, on a bridge deck, in a tunnel (both: on an upper deck)
  w.u8((s.veh ? 1 : 0) | (s.lvl === 1 || s.lvl === 2 ? 2 : 0) | (s.lvl === -1 || s.lvl === 2 ? 4 : 0));
  w.pos(s.x);
  w.pos(s.y);
  w.ang16(s.a);
  w.vel(s.vx);
  w.vel(s.vy);
  w.u8(Math.max(0, WEAPON_LIST.indexOf(s.weapon)));
  w.i8(s.camDx);
  w.i8(s.camDy);
  w.u16(s.hw * 10);
  w.u16(s.hh * 10);
  const v = s.veh;
  if (!v) return;
  w.u16(v.vid);
  w.i16(v.av * 1000);
  w.i8(v.steer * 127);
  w.i8(v.throttle * 127);
  w.u8((v.handbrake ? 1 : 0) | (v.boost ? 2 : 0) | (v.siren ? 4 : 0) | (v.horn ? 8 : 0) | (v.boosting ? 16 : 0) | (v.wrecked ? 32 : 0) | (v.tyres ? 64 : 0));
  w.u16(v.health * 10);
  w.u16(packDmg({ front: v.dmg[0], rear: v.dmg[1], left: v.dmg[2], right: v.dmg[3] }));
  w.i16(v.fire * 100);
  w.u16(v.sinking * 100);
  w.u8(v.nitro * 255);
  w.u8(v.skid * 255);
}

export function decodeState(r: Reader): StateReport {
  if (r.u8() !== MSG_STATE) throw new RangeError('not a state message');
  const seq = r.u16(), epoch = r.u8(), flags = r.u8();
  const s: StateReport = {
    seq, epoch, lvl: levelOf(flags >> 1),
    x: r.pos(), y: r.pos(), a: r.ang16(), vx: r.vel(), vy: r.vel(),
    weapon: WEAPON_LIST[r.u8()] ?? 'fist',
    camDx: r.i8(), camDy: r.i8(), hw: r.u16() / 10, hh: r.u16() / 10,
    veh: null,
  };
  if (flags & 1) {
    const vid = r.u16(), av = r.i16() / 1000, steer = r.i8() / 127, throttle = r.i8() / 127, bits = r.u8();
    s.veh = {
      vid, av, steer, throttle,
      handbrake: !!(bits & 1), boost: !!(bits & 2), siren: !!(bits & 4), horn: !!(bits & 8), boosting: !!(bits & 16), wrecked: !!(bits & 32), tyres: !!(bits & 64),
      health: r.u16() / 10, dmg: unpackDmg(r.u16()), fire: r.i16() / 100, sinking: r.u16() / 100, nitro: r.u8() / 255, skid: r.u8() / 255,
    };
  }
  return s;
}

// ------------------------------------------------------------------- server SNAPSHOT
export interface PrivateState {
  health: number;
  armor: number;
  wanted: number;
  state: 'play' | 'wasted' | 'busted';
  stateTimer: number;
  searching: boolean;
  shotCops: boolean;
  money: number;
  /** pistol, uzi, shotgun */
  ammo: [number, number, number];
  epoch: number;
  zone: { x: number; y: number; r: number } | null;
}

const PSTATES = ['play', 'wasted', 'busted'] as const;

export function encodeSnapshotHeader(w: Writer, tick: number, serverMs: number, ack: number, me: PrivateState) {
  w.u8(MSG_SNAPSHOT);
  w.u32(tick);
  w.f64(serverMs);
  w.u16(ack & 0xffff);
  w.u8(me.health);
  w.u8(me.armor);
  w.u8(me.wanted * 20);
  w.u8(PSTATES.indexOf(me.state) | (me.searching ? 4 : 0) | (me.zone ? 8 : 0) | (me.shotCops ? 16 : 0));
  w.u8(me.stateTimer * 10);
  w.u32(me.money);
  for (const a of me.ammo) w.u16(a);
  w.u8(me.epoch);
  if (me.zone) {
    w.pos(me.zone.x);
    w.pos(me.zone.y);
    w.u8(me.zone.r);
  }
}

// entity records: u16 id, u8 head (type:3 | static:1<<3 | on a deck:1<<4 | in a tunnel:1<<5), [static], dynamic
export function entityHead(w: Writer, id: number, type: Ent, withStatic: boolean, level: Level) {
  w.u16(id);
  w.u8(type | (withStatic ? 8 : 0) | (level === 1 || level === 2 ? 16 : 0) | (level === -1 || level === 2 ? 32 : 0));
}

/** static part of a vehicle: changes only when `rev` bumps */
export function vehicleStatic(w: Writer, v: Vehicle, swat: boolean) {
  w.u8(VEHICLE_KINDS.indexOf(v.kind));
  const c = parseInt(v.color.slice(1), 16) || 0;
  w.u8((c >> 16) & 255);
  w.u8((c >> 8) & 255);
  w.u8(c & 255);
  w.u8((v.mission ? 1 : 0) | (swat ? 2 : 0));
  w.u16(v.owner);
}

export function vehicleDynamic(w: Writer, v: Vehicle) {
  w.pos(v.x);
  w.pos(v.y);
  w.ang16(v.angle);
  w.vel(v.vx);
  w.vel(v.vy);
  w.i16(v.av * 1000);
  w.i8(v.steer * 127);
  w.i8(v.ctrl.throttle * 127);
  w.u8((v.health / v.spec.health) * 255);
  w.u16(packDmg(v.dmg));
  const skid = clampInt(v.skid * 3, 0, 3);
  const flags =
    (v.siren ? 1 : 0) | (v.boosting ? 2 : 0) | (skid << 2) | (v.fire > 0 ? 16 : 0) | (v.wrecked ? 32 : 0) | (v.sinking ? 64 : 0) |
    (v.tyresBurst ? 128 : 0) | (v.horn > 0 ? 256 : 0) | (v.ctrl.handbrake ? 512 : 0) | (v.parked ? 1024 : 0);
  w.u16(flags);
  if (v.sinking) w.u8(v.sinking * 50);
}

export function pedStatic(w: Writer, p: Ped) {
  w.u8(PED_KINDS.indexOf(p.kind));
  w.u32(p.seed);
  w.u8(p.outfit === 'swat' ? 1 : 0);
  w.u8(p.look);
  w.u16(p.playerId);
}

export function pedDynamic(w: Writer, p: Ped, stars: number) {
  w.pos(p.x);
  w.pos(p.y);
  w.ang8(p.angle);
  w.u8(Math.max(0, PED_STATES.indexOf(p.state)) | (p.handsUp ? 8 : 0) | (Math.max(0, WEAPON_LIST.indexOf(p.weapon)) << 4) | (p.playerId ? 64 : 0));
  if (p.playerId) {
    w.u16(p.vehicle?.id ?? 0);
    w.u8(stars);
  }
}

export function tramDynamic(w: Writer, t: Tram) {
  for (let i = 0; i < 3; i++) {
    const s = t.sections[i] ?? { x: t.x, y: t.y, a: t.angle };
    w.pos(s.x);
    w.pos(s.y);
    w.ang16(s.a);
  }
  w.u8(t.speed * 10);
}

export function pickupStatic(w: Writer, p: Pickup) {
  w.u8(PICKUP_KINDS.indexOf(p.kind));
  w.u16(p.amount);
  w.pos(p.x);
  w.pos(p.y);
  w.i8(p.cumil);
}

export function propStatic(w: Writer, p: Prop) {
  w.u8(PROP_KINDS.indexOf(p.kind));
  w.pos(p.x);
  w.pos(p.y);
  w.ang16(p.angle);
  w.u8(p.len * 10);
  w.u16(p.owner);
}

export function propDynamic(w: Writer, p: Prop) {
  w.u8(p.active ? 1 : 0);
}

export function heliStatic(w: Writer, h: Helicopter) {
  w.u16(h.targetPid);
}

export function heliDynamic(w: Writer, h: Helicopter) {
  w.pos(h.x);
  w.pos(h.y);
  w.ang16(h.angle);
  w.pos(h.tx);
  w.pos(h.ty);
}

// ------------------------------------------------------------------ decoding (client)
export interface VehicleRec {
  kind?: VehicleKind;
  color?: string;
  mission?: boolean;
  swat?: boolean;
  owner?: number;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  av: number;
  steer: number;
  throttle: number;
  health: number;
  dmg: [number, number, number, number];
  siren: boolean;
  boosting: boolean;
  skid: number;
  burning: boolean;
  wrecked: boolean;
  sinking: number;
  tyres: boolean;
  horn: boolean;
  handbrake: boolean;
  parked: boolean;
}

export interface PedRec {
  kind?: 'civ' | 'cop' | 'player';
  seed?: number;
  swat?: boolean;
  look?: number;
  playerId?: number;
  x: number;
  y: number;
  a: number;
  state: PedState;
  handsUp: boolean;
  weapon: WeaponId;
  vehicle: number;
  stars: number;
}

export interface TramRec {
  sections: { x: number; y: number; a: number }[];
  speed: number;
}

export interface PickupRec {
  kind: PickupKind;
  amount: number;
  x: number;
  y: number;
  cumil: number;
}

export interface PropRec {
  kind?: PropKind;
  x?: number;
  y?: number;
  a?: number;
  len?: number;
  owner?: number;
  active: boolean;
}

export interface HeliRec {
  targetPid?: number;
  x: number;
  y: number;
  a: number;
  tx: number;
  ty: number;
}

export type EntityRec =
  | { id: number; type: Ent.Vehicle; level: Level; full: boolean; v: VehicleRec }
  | { id: number; type: Ent.Ped; level: Level; full: boolean; v: PedRec }
  | { id: number; type: Ent.Tram; level: Level; full: boolean; v: TramRec }
  | { id: number; type: Ent.Pickup; level: Level; full: boolean; v: PickupRec | null }
  | { id: number; type: Ent.Prop; level: Level; full: boolean; v: PropRec }
  | { id: number; type: Ent.Heli; level: Level; full: boolean; v: HeliRec };

export interface Snapshot {
  tick: number;
  st: number;
  ack: number;
  me: PrivateState;
  ents: EntityRec[];
  gone: number[];
}

export function decodeSnapshot(r: Reader): Snapshot {
  if (r.u8() !== MSG_SNAPSHOT) throw new RangeError('not a snapshot');
  const tick = r.u32(), st = r.f64(), ack = r.u16();
  const health = r.u8(), armor = r.u8(), wanted = r.u8() / 20, bits = r.u8(), stateTimer = r.u8() / 10, money = r.u32();
  const ammo: [number, number, number] = [r.u16(), r.u16(), r.u16()];
  const epoch = r.u8();
  const zone = bits & 8 ? { x: r.pos(), y: r.pos(), r: r.u8() } : null;
  const me: PrivateState = { health, armor, wanted, state: PSTATES[bits & 3] ?? 'play', stateTimer, searching: !!(bits & 4), shotCops: !!(bits & 16), money, ammo, epoch, zone };
  const n = r.u16();
  const ents: EntityRec[] = [];
  for (let i = 0; i < n; i++) ents.push(decodeEntity(r));
  const g = r.u16();
  const gone: number[] = [];
  for (let i = 0; i < g; i++) gone.push(r.u16());
  return { tick, st, ack, me, ents, gone };
}

function decodeEntity(r: Reader): EntityRec {
  const id = r.u16(), head = r.u8();
  const type = (head & 7) as Ent, full = !!(head & 8), level = levelOf(head >> 4);
  switch (type) {
    case Ent.Vehicle: {
      const v = {} as VehicleRec;
      if (full) {
        v.kind = VEHICLE_KINDS[r.u8()] ?? 'sedan';
        const c = (r.u8() << 16) | (r.u8() << 8) | r.u8();
        v.color = '#' + c.toString(16).padStart(6, '0');
        const b = r.u8();
        v.mission = !!(b & 1);
        v.swat = !!(b & 2);
        v.owner = r.u16();
      }
      v.x = r.pos();
      v.y = r.pos();
      v.a = r.ang16();
      v.vx = r.vel();
      v.vy = r.vel();
      v.av = r.i16() / 1000;
      v.steer = r.i8() / 127;
      v.throttle = r.i8() / 127;
      v.health = r.u8() / 255;
      v.dmg = unpackDmg(r.u16());
      const f = r.u16();
      v.siren = !!(f & 1);
      v.boosting = !!(f & 2);
      v.skid = ((f >> 2) & 3) / 3;
      v.burning = !!(f & 16);
      v.wrecked = !!(f & 32);
      v.sinking = f & 64 ? r.u8() / 50 : 0;
      v.tyres = !!(f & 128);
      v.horn = !!(f & 256);
      v.handbrake = !!(f & 512);
      v.parked = !!(f & 1024);
      return { id, type, level, full, v };
    }
    case Ent.Ped: {
      const v = {} as PedRec;
      if (full) {
        v.kind = PED_KINDS[r.u8()] ?? 'civ';
        v.seed = r.u32();
        v.swat = r.u8() === 1;
        v.look = r.u8();
        v.playerId = r.u16();
      }
      v.x = r.pos();
      v.y = r.pos();
      v.a = r.ang8();
      const b = r.u8();
      v.state = PED_STATES[b & 7] ?? 'walk';
      v.handsUp = !!(b & 8);
      v.weapon = WEAPON_LIST[(b >> 4) & 3];
      v.vehicle = b & 64 ? r.u16() : 0;
      v.stars = b & 64 ? r.u8() : 0;
      return { id, type, level, full, v };
    }
    case Ent.Tram: {
      const sections = [];
      for (let i = 0; i < 3; i++) sections.push({ x: r.pos(), y: r.pos(), a: r.ang16() });
      return { id, type, level, full, v: { sections, speed: r.u8() / 10 } };
    }
    case Ent.Pickup:
      if (!full) return { id, type, level, full, v: null };
      return { id, type, level, full, v: { kind: PICKUP_KINDS[r.u8()] ?? 'cash', amount: r.u16(), x: r.pos(), y: r.pos(), cumil: r.i8() } };
    case Ent.Prop: {
      const v = {} as PropRec;
      if (full) {
        v.kind = PROP_KINDS[r.u8()] ?? 'barrier';
        v.x = r.pos();
        v.y = r.pos();
        v.a = r.ang16();
        v.len = r.u8() / 10;
        v.owner = r.u16();
      }
      v.active = r.u8() === 1;
      return { id, type, level, full, v };
    }
    case Ent.Heli: {
      const v = {} as HeliRec;
      if (full) v.targetPid = r.u16();
      v.x = r.pos();
      v.y = r.pos();
      v.a = r.ang16();
      v.tx = r.pos();
      v.ty = r.pos();
      return { id, type, level, full, v };
    }
    default:
      throw new RangeError('unknown entity type ' + type);
  }
}
