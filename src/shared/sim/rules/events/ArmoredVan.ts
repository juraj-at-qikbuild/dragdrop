// Obrnené auto: an armoured cash van drives bank -> bank -> bank, stopping 15 s at the middle bank.
// Its rear doors have their own hit-point pool, separate from the van's own health: shoot them out and
// it stops for good, spilling its cash behind it. A wreck (or running it out of health any other way)
// spills the same cash; reaching the last bank "delivers" it; 6 minutes live with neither ends it early.
// Plan: docs/plans/social-events.md
import type { Sim } from '../../Sim';
import type { SimPlayer } from '../../SimPlayer';
import type { Pickup } from '../../Pickups';
import type { SimRule } from '../SimRule';
import { LIVERY_ARMORED, LIVERY_NONE, SPECS, Vehicle } from '../../../entities/Vehicle';
import { linkPoints, type Link } from '../../../world/Graph';
import { dist } from '../../../util/math';
import { TimedEvent, type WorldEventDef, type WorldEvents } from '../WorldEvents';
import type { EventEntry } from '../types';
import { placeName } from '../placeName';
import { centroidOf, clearOfPlayers } from './placement';

const ANNOUNCE_S = 30;
const LIVE_MAX_S = 6 * 60;
/** how far the start bank may be from the players' centroid */
const BANK_MIN = 300, BANK_MAX = 1500;
/** each leg (A -> B, B -> C), measured along the road, not as the crow flies */
const LEG_MIN = 1000, LEG_MAX = 2000;
const PLAYER_CLEARANCE = 120;
/** a bank snaps to the nearest car-graph node within this radius, or it's not a candidate */
const SNAP_MAX = 300;
/** "arrived" at bank B (stop and dwell) or bank C (delivered) */
const ARRIVE_R = 20;
const DWELL_S = 15;
const DOOR_HP = 100;
/** a rear hit counts towards the robbery only if it landed this recently when the doors burst */
const REAR_HITTER_WINDOW = 10;
const SPILL_COUNT = 12;
const SPILL_TOTAL = 1200;
const SPILL_MIN_R = 2, SPILL_MAX_R = 5;
/** the spill lands behind the van, within this half-angle of dead astern */
const SPILL_CONE = Math.PI / 3;
const VAN_ARMOR = 0.2;
const VAN_HEALTH = 600;
const VAN_COLOR = '#24272b';
/** `entry().place` is recomputed at most this often */
const PLACE_REFRESH = 10;
/** bounded search for a start bank + two more banks whose legs fit, and a kerb spot to start from */
const MAX_TRIES = 60;

interface Spot {
  x: number;
  y: number;
  angle: number;
}
interface Bank {
  x: number;
  y: number;
}
interface Route {
  b: Bank;
  c: Bank;
  legAB: Link[];
  legBC: Link[];
  spot: Spot;
}

/** stand-clear check along the van's length (Kofolka.ts's own copy, private there too) */
function clearOfWalls(sim: Sim, x: number, y: number, angle: number): boolean {
  const s = SPECS.van, r = s.width / 2, n = Math.max(2, Math.ceil(s.length / s.width));
  const fx = Math.cos(angle), fy = Math.sin(angle);
  for (let i = 0; i < n; i++) {
    const o = -s.length / 2 + r + ((s.length - 2 * r) * i) / (n - 1);
    if (sim.world.collideCircle(x + fx * o, y + fy * o, r, 0)) return false;
  }
  return true;
}

/** Park at the kerb right at the start of `link` (Kofolka's findSpot offsets a random link the same
 *  way; here it has to be this exact link, since the driver sets off along it). */
function kerbSpotAtStart(sim: Sim, link: Link): Spot | null {
  const w = sim.world;
  const pts = linkPoints(link);
  const angle = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
  const off = linkPoints(link, link.edge.width / 2 - 1);
  const x = off[0], y = off[1];
  if (w.spawnLevel(x, y, SPECS.van.width / 2, angle) !== 0) return null; // not a tunnel or deck
  if (!clearOfWalls(sim, x, y, angle)) return null; // not inside a building
  return { x, y, angle };
}

const legLength = (links: Link[]) => links.reduce((s, l) => s + l.edge.len, 0);

/** Bank A: 300-1500 m from the players, clear of them, at level 0, snapped to the car graph. Banks B
 *  and C: any other two banks whose legs (by road, A -> B and B -> C) are each 1.0-2.0 km. Tries a
 *  bounded number of random combinations; null when nothing fits. */
function findRoute(sim: Sim, cx: number, cy: number): Route | null {
  const w = sim.world;
  const banks = w.places('bank');
  if (banks.length < 3) return null;
  const starts = banks.filter((b) => {
    const d = dist(b.x, b.y, cx, cy);
    return d >= BANK_MIN && d <= BANK_MAX && clearOfPlayers(sim, b.x, b.y, PLAYER_CLEARANCE) && w.spawnLevel(b.x, b.y, 0.5) === 0;
  });
  if (!starts.length) return null;
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const a = sim.rng.pick(starts);
    const nodeA = w.car.nearest(a.x, a.y, SNAP_MAX);
    if (nodeA < 0) continue;
    const b = sim.rng.pick(banks);
    if (b === a) continue;
    const nodeB = w.car.nearest(b.x, b.y, SNAP_MAX);
    if (nodeB < 0) continue;
    const legAB = w.car.path(nodeA, nodeB);
    if (!legAB || !legAB.length) continue;
    if (legLength(legAB) < LEG_MIN || legLength(legAB) > LEG_MAX) continue;
    const c = sim.rng.pick(banks);
    if (c === a || c === b) continue;
    const nodeC = w.car.nearest(c.x, c.y, SNAP_MAX);
    if (nodeC < 0) continue;
    const legBC = w.car.path(nodeB, nodeC);
    if (!legBC || !legBC.length) continue;
    if (legLength(legBC) < LEG_MIN || legLength(legBC) > LEG_MAX) continue;
    const spot = kerbSpotAtStart(sim, legAB[0]);
    if (!spot) continue;
    return { b, c, legAB, legBC, spot };
  }
  return null;
}

class ArmoredVan extends TimedEvent {
  private van: Vehicle;
  private b: Bank;
  private c: Bank;
  private legAB: Link[];
  private legBC: Link[];
  private sub: 'toB' | 'atB' | 'toC' = 'toB';
  private dwell = 0;
  private doorHp = DOOR_HP;
  /** {pid, time}: who last hit the rear and when, for the robbery credit when the doors burst */
  private rearHitters = new Map<number, number>();
  /** set the instant the doors burst: update() then just unwinds, ignoring anything else that happens */
  private ended = false;
  private place: string;
  private placeAt: number;

  constructor(sim: Sim, director: WorldEvents, id: number, route: Route) {
    super(sim, director, id, 'armored', ANNOUNCE_S, LIVE_MAX_S);
    const v = new Vehicle('van', route.spot.x, route.spot.y, route.spot.angle, VAN_COLOR);
    v.mission = true; // exempt from AI despawn/thinning
    v.livery = LIVERY_ARMORED;
    v.locked = true;
    v.armor = VAN_ARMOR;
    v.maxHealth = VAN_HEALTH;
    v.health = VAN_HEALTH;
    v.parked = true;
    sim.addVehicle(v);
    this.van = v;
    this.legAB = route.legAB;
    this.legBC = route.legBC;
    this.b = route.b;
    this.c = route.c;
    this.place = placeName(sim.world, v.x, v.y);
    this.placeAt = sim.time;
    sim.events.global({ k: 'eventAnnounce', kind: 'armored', x: v.x, y: v.y, secs: ANNOUNCE_S });
  }

  protected onLive() {
    const sim = this.sim, v = this.van;
    sim.events.global({ k: 'eventStart', kind: 'armored', x: v.x, y: v.y });
    v.parked = false;
    sim.ai.driveRoute(v, this.legAB);
  }

  update(dt: number): boolean {
    this.tick(dt);
    if (this.ended) return false;
    const sim = this.sim, v = this.van;
    if (!sim.vehicleById(v.id)) return false; // gone (sank, or swept): end quietly, nothing to clean up
    if (v.wrecked || v.health <= 0) return this.endWrecked();
    if (this.phase === 'live' && this.left <= 0) return this.endExpired(); // 6 min live
    if (this.phase !== 'live') return true; // still announcing: the van waits at bank A

    switch (this.sub) {
      case 'toB':
        if (dist(v.x, v.y, this.b.x, this.b.y) <= ARRIVE_R) {
          this.sub = 'atB';
          this.dwell = DWELL_S;
          sim.ai.drivers.delete(v);
          v.setControls(0, 0, true);
          v.parked = true;
        }
        break;
      case 'atB':
        this.dwell -= dt;
        if (this.dwell <= 0) {
          v.parked = false;
          sim.ai.driveRoute(v, this.legBC);
          this.sub = 'toC';
        }
        break;
      case 'toC':
        if (dist(v.x, v.y, this.c.x, this.c.y) <= ARRIVE_R) return this.endDelivered();
        break;
    }

    if (sim.time - this.placeAt >= PLACE_REFRESH) {
      this.placeAt = sim.time;
      this.place = placeName(sim.world, v.x, v.y);
    }
    return true;
  }

  /** A rear hit drains the door HP by the weapon's car damage before armour (armour already scaled
   *  `dmg` down in Combat.applyShot, so dividing it back out recovers that pre-armour amount). */
  onVehicleHit(v: Vehicle, dmg: number, byPid: number, hx: number, hy: number) {
    if (v !== this.van || this.ended) return;
    if (v.damageZoneAt(hx, hy) !== 'rear') return;
    if (byPid) this.rearHitters.set(byPid, this.sim.time);
    this.doorHp -= dmg / v.armor;
    if (this.doorHp <= 0) this.burstDoors(byPid);
  }

  /** the doors give way: stop for good, spill the cash, and book the robbery against whoever's been
   *  shooting the rear in the last `REAR_HITTER_WINDOW` s (the one who landed this shot included) */
  private burstDoors(byPid: number) {
    const sim = this.sim, v = this.van;
    this.ended = true;
    this.spillCash();
    const now = sim.time;
    for (const [pid, t] of this.rearHitters) {
      if (now - t > REAR_HITTER_WINDOW) continue;
      const p = sim.players.get(pid);
      if (p) sim.crime(p, 'robbery');
    }
    const winner = byPid ? sim.players.get(byPid)?.nick : undefined;
    sim.events.global({ k: 'eventEnd', kind: 'armored', how: 'robbed', winner, amount: SPILL_TOTAL, x: v.x, y: v.y });
    this.retire();
  }

  /** SPILL_COUNT cash pickups worth SPILL_TOTAL in all, tagged 'van' (VanLoot pays the `loot` crime for
   *  them), scattered 2-5 m behind the van within a cone of the reverse of its heading. */
  private spillCash() {
    const sim = this.sim, v = this.van;
    const back = v.angle + Math.PI;
    const per = SPILL_TOTAL / SPILL_COUNT;
    for (let i = 0; i < SPILL_COUNT; i++) {
      const a = back + (sim.rng.next() * 2 - 1) * SPILL_CONE;
      const r = sim.rng.range(SPILL_MIN_R, SPILL_MAX_R);
      sim.dropCash(v.x + Math.cos(a) * r, v.y + Math.sin(a) * r, per, 'van');
    }
  }

  private endWrecked(): false {
    const sim = this.sim, v = this.van;
    this.spillCash();
    sim.events.global({ k: 'eventEnd', kind: 'armored', how: 'wrecked', x: v.x, y: v.y });
    this.retire();
    return false;
  }

  private endExpired(): false {
    const sim = this.sim, v = this.van;
    sim.events.global({ k: 'eventEnd', kind: 'armored', how: 'expired', x: v.x, y: v.y });
    this.retire();
    return false;
  }

  private endDelivered(): false {
    const sim = this.sim, v = this.van;
    sim.events.global({ k: 'eventEnd', kind: 'armored', how: 'delivered', x: v.x, y: v.y });
    this.retire();
    return false;
  }

  /** back to an ordinary van: no more mission exemption, lock, armour or paint job, and stopped for
   *  good (whatever drove it, if anything, is dropped: the vehicle keeps its position and rests there) */
  private retire() {
    const v = this.van;
    this.sim.ai.drivers.delete(v);
    v.setControls(0, 0, true);
    v.mission = false;
    v.livery = LIVERY_NONE;
    v.locked = false;
    v.armor = 1;
    v.maxHealth = 0;
    v.rev++;
  }

  entry(): EventEntry {
    const v = this.van;
    return {
      id: this.id, kind: 'armored', phase: this.phase, left: Math.max(0, this.left),
      x: v.x, y: v.y, vid: v.id, pot: SPILL_TOTAL, place: this.place,
    };
  }

  stop() {
    if (this.sim.vehicleById(this.van.id)) this.retire();
  }
}

export const ARMORED_DEF: WorldEventDef = {
  kind: 'armored',
  minPlayers: 2,
  offline: true,
  scheduled: true,
  weight: 1,
  cooldown: 1200,
  create(sim, director, id) {
    const c = centroidOf(sim);
    if (!c) return null;
    const route = findRoute(sim, c.x, c.y);
    if (!route) return null;
    return new ArmoredVan(sim, director, id, route);
  },
};

/** The armoured van's spilled cash outlives the event that dropped it: a tiny always-on rule (register
 *  it for both offline and online) that pays the `loot` crime whenever any of it is picked up. */
export class VanLoot implements SimRule {
  readonly id = 'vanLoot';
  constructor(private sim: Sim) {}

  onPickup(p: SimPlayer, pk: Pickup) {
    if (pk.tag === 'van') this.sim.crime(p, 'loot');
  }
}
