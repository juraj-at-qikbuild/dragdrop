// Builds each client's binary SNAPSHOT: their private state plus every entity in their interest area
// that changed since the last snapshot they got. WebSocket delivery is reliable and ordered, so "what the
// client knows" is simply what we sent it; unchanged entities (parked cars, the dead, pickups) cost
// nothing after the first send. Far entities are refreshed at half rate.
import type { Sim } from '../../src/shared/sim/Sim';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import type { Vehicle } from '../../src/shared/entities/Vehicle';
import type { Ped } from '../../src/shared/entities/Ped';
import type { Tram } from '../../src/shared/entities/Tram';
import type { Prop } from '../../src/shared/entities/Props';
import type { Helicopter } from '../../src/shared/entities/Helicopter';
import type { Pickup } from '../../src/shared/sim/Pickups';
import { SpatialHash } from '../../src/shared/util/SpatialHash';
import {
  Ent, Writer, encodeSnapshotHeader, entityHead, heliDynamic, heliStatic, pedDynamic, pedStatic, pickupStatic, propDynamic, propStatic,
  tramDynamic, vehicleDynamic, vehicleStatic, type PrivateState,
} from '../../src/shared/net/codec';

/** interest radius for vehicles, trams, props, helicopters and pickups */
export const INTEREST_R = 300;
/** people are small: a tighter radius */
export const PED_R = 200;
/** entities stay sent until this much further away (no flicker at the edge) */
export const HYSTERESIS = 30;
/** beyond this distance an entity is refreshed every other tick */
const NEAR_R = 150;

type Obj = Vehicle | Ped | Tram | Pickup | Prop | Helicopter;

interface Entry {
  id: number;
  type: Ent;
  x: number;
  y: number;
  level: 0 | 1;
  obj: Obj;
}

interface Encoded {
  stat: Uint8Array;
  shash: number;
  dyn: Uint8Array;
  dhash: number;
}

interface Known {
  type: Ent;
  shash: number;
  dhash: number;
}

/** what one client has been sent */
export class ClientView {
  known = new Map<number, Known>();
  reset() {
    this.known.clear();
  }
}

export class SnapshotBuilder {
  private grid = new SpatialHash<Entry>(100);
  private cache = new Map<Obj, Encoded>();
  private scratch = new Writer(256);
  private out = new Writer(16 * 1024);
  private tick = 0;
  /** bytes written this tick, for /stats */
  bytes = 0;

  constructor(private sim: Sim) {}

  /** once per tick, after sim.step */
  prepare(tick: number) {
    this.tick = tick;
    this.grid.clear();
    this.cache.clear();
    const sim = this.sim;
    const add = (id: number, type: Ent, x: number, y: number, level: 0 | 1, obj: Obj) => this.grid.insert({ id, type, x, y, level, obj }, x, y);
    for (const v of sim.vehicles) add(v.id, Ent.Vehicle, v.x, v.y, v.level, v);
    for (const p of sim.peds) if (!p.vehicle || p.playerId) add(p.id, Ent.Ped, p.x, p.y, p.level, p);
    for (const t of sim.trams) add(t.id, Ent.Tram, t.x, t.y, t.level, t);
    for (const pk of sim.pickups) if (pk.hidden === 0) add(pk.id, Ent.Pickup, pk.x, pk.y, 0, pk);
    for (const pr of sim.props) add(pr.id, Ent.Prop, pr.x, pr.y, pr.level, pr);
    for (const h of sim.police.helis()) add(h.id, Ent.Heli, h.x, h.y, 0, h);
  }

  private encode(e: Entry): Encoded {
    let enc = this.cache.get(e.obj);
    if (enc) return enc;
    const w = this.scratch.reset();
    const sim = this.sim;
    switch (e.type) {
      case Ent.Vehicle:
        vehicleStatic(w, e.obj as Vehicle, sim.police.swat.has(e.obj as Vehicle));
        break;
      case Ent.Ped:
        pedStatic(w, e.obj as Ped);
        break;
      case Ent.Pickup:
        pickupStatic(w, e.obj as Pickup);
        break;
      case Ent.Prop:
        propStatic(w, e.obj as Prop);
        break;
      case Ent.Heli:
        heliStatic(w, e.obj as Helicopter);
        break;
    }
    const stat = w.finish();
    const shash = w.hash(0);
    w.reset();
    switch (e.type) {
      case Ent.Vehicle:
        vehicleDynamic(w, e.obj as Vehicle);
        break;
      case Ent.Ped: {
        const p = e.obj as Ped;
        pedDynamic(w, p, p.playerId ? sim.players.get(p.playerId)?.stars ?? 0 : 0);
        break;
      }
      case Ent.Tram:
        tramDynamic(w, e.obj as Tram);
        break;
      case Ent.Prop:
        propDynamic(w, e.obj as Prop);
        break;
      case Ent.Heli:
        heliDynamic(w, e.obj as Helicopter);
        break;
    }
    enc = { stat, shash, dyn: w.finish(), dhash: w.hash(0) };
    this.cache.set(e.obj, enc);
    return enc;
  }

  /** the snapshot for one player's client */
  build(p: SimPlayer, view: ClientView, serverMs: number, ack: number): Uint8Array {
    const w = this.out.reset();
    encodeSnapshotHeader(w, this.tick, serverMs, ack, privateState(p));
    const countAt = w.n;
    w.u16(0);
    let count = 0;
    const f = p.focus();
    const own = p.ped.vehicle;
    const visible = new Set<number>();
    const found = p.profile.cumils;
    this.grid.query(f.x, f.y, INTEREST_R + HYSTERESIS, (e) => {
      if (e.obj === p.ped || e.obj === own) return;
      const r = e.type === Ent.Ped ? PED_R : INTEREST_R;
      const d = Math.hypot(e.x - f.x, e.y - f.y);
      const known = view.known.get(e.id);
      if (d > r && !(known && known.type === e.type && d < r + HYSTERESIS)) return;
      if (e.type === Ent.Pickup && (e.obj as Pickup).cumil >= 0 && found.includes((e.obj as Pickup).cumil)) return;
      visible.add(e.id);
      // far away and already known: every other tick is enough
      if (known && d > NEAR_R && (this.tick + e.id) % 2) return;
      const enc = this.encode(e);
      const sameType = known && known.type === e.type;
      if (sameType && known.shash === enc.shash && known.dhash === enc.dhash) return;
      const withStatic = !sameType || known!.shash !== enc.shash;
      entityHead(w, e.id, e.type, withStatic, e.level);
      if (withStatic) w.bytes(enc.stat);
      w.bytes(enc.dyn);
      view.known.set(e.id, { type: e.type, shash: enc.shash, dhash: enc.dhash });
      count++;
    });
    w.patchU16(countAt, count);
    const gone: number[] = [];
    for (const id of view.known.keys()) {
      if (visible.has(id)) continue;
      view.known.delete(id);
      // the player's own car isn't "gone", it just stopped being theirs to watch
      if (own && id === own.id) continue;
      gone.push(id);
    }
    w.u16(gone.length);
    for (const id of gone) w.u16(id);
    this.bytes += w.n;
    return w.finish();
  }
}

export function privateState(p: SimPlayer): PrivateState {
  const ped = p.ped;
  return {
    health: Math.max(0, Math.min(255, Math.ceil(ped.health))),
    armor: Math.max(0, Math.min(255, Math.ceil(ped.armor))),
    wanted: p.wanted,
    state: p.state,
    stateTimer: Math.max(0, p.stateTimer),
    searching: p.searching,
    shotCops: p.shotCops,
    money: Math.max(0, Math.round(p.profile.money)),
    ammo: [ammo(p.ammo.pistol), ammo(p.ammo.uzi), ammo(p.ammo.shotgun)],
    epoch: p.epoch,
    zone: p.searchZone ? { x: p.searchZone.x, y: p.searchZone.y, r: Math.min(255, p.searchZone.r) } : null,
  };
}

const ammo = (n: number) => Math.max(0, Math.min(65535, Math.floor(n)));
