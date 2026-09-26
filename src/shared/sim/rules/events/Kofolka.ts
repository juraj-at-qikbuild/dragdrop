// Horúca Kofolka: a Kofolka-branded delivery van parked somewhere in the city, marked `mission` (so
// it never despawns) and carrying a $1,500 pot. Whoever drives it earns $10/s out of the pot until it
// drains, the van is wrecked (the rest spills as cash) or the event times out. Box-in-and-ram is the
// existing rule that a player's car can only be jacked while (nearly) stopped.
// Plan: docs/plans/social-events.md
import type { Sim } from '../../Sim';
import { LIVERY_KOFOLKA, LIVERY_NONE, SPECS, Vehicle } from '../../../entities/Vehicle';
import { linkPoints } from '../../../world/Graph';
import { dist } from '../../../util/math';
import { TimedEvent, type WorldEventDef, type WorldEvents } from '../WorldEvents';
import type { EventEntry } from '../types';
import { placeName } from '../placeName';

const POT = 1500;
const PAYOUT_PER_SEC = 10;
const ANNOUNCE_S = 30;
const LIVE_MAX_S = 8 * 60;
/** ends early if nobody has ever driven it this long into the live phase */
const UNTAKEN_TIMEOUT_S = 3 * 60;
const SPAWN_MIN = 500, SPAWN_MAX = 1500;
const PLAYER_CLEARANCE = 150;
/** a holder-change announcement, at most this often */
const HOLDER_ANNOUNCE_GAP = 10;
/** `entry().place` is recomputed at most this often */
const PLACE_REFRESH = 10;
const SPILL_MIN_POT = 50;
const SPILL_MAX_PICKUPS = 10;
const KOFOLKA_RED = '#c8102e';

/** the observing players' centroid, or null when there are none (nothing to spawn near) */
function centroidOf(sim: Sim): { x: number; y: number } | null {
  const obs = sim.observers();
  if (!obs.length) return null;
  let x = 0, y = 0;
  for (const p of obs) {
    const f = p.focus();
    x += f.x;
    y += f.y;
  }
  return { x: x / obs.length, y: y / obs.length };
}

function clearOfPlayers(sim: Sim, x: number, y: number, minD: number): boolean {
  for (const p of sim.players.values()) if (dist(x, y, p.focus().x, p.focus().y) < minD) return false;
  return true;
}

/** stand-clear check along the van's length (AI.ts's own `clearOfWalls`, private there) */
function clearOfWalls(sim: Sim, x: number, y: number, angle: number): boolean {
  const s = SPECS.van, r = s.width / 2, n = Math.max(2, Math.ceil(s.length / s.width));
  const fx = Math.cos(angle), fy = Math.sin(angle);
  for (let i = 0; i < n; i++) {
    const o = -s.length / 2 + r + ((s.length - 2 * r) * i) / (n - 1);
    if (sim.world.collideCircle(x + fx * o, y + fy * o, r, 0)) return false;
  }
  return true;
}

interface Spot {
  x: number;
  y: number;
  angle: number;
}

/** A drivable, level-0 car-graph link whose midpoint is `SPAWN_MIN`..`SPAWN_MAX` m from (cx, cy) and
 *  at least `PLAYER_CLEARANCE` m from every player, parked at its kerb (AI.ts's `spawnParked` does the
 *  same for ordinary parked traffic: pick a node in the annulus, then one of its links). */
function findSpot(sim: Sim, cx: number, cy: number): Spot | null {
  const w = sim.world;
  const nodes = w.car.nodesAround(cx, cy, SPAWN_MIN, SPAWN_MAX);
  for (let tries = 0; tries < 30 && nodes.length; tries++) {
    const n = sim.rng.pick(nodes);
    const links = w.car.out[n].filter((l) => !(l.fwd ? l.edge.blockedF : l.edge.blockedR));
    if (!links.length) continue;
    const link = sim.rng.pick(links);
    const pts = linkPoints(link);
    const mx = (pts[0] + pts[pts.length - 2]) / 2, my = (pts[1] + pts[pts.length - 1]) / 2;
    const d = dist(mx, my, cx, cy);
    if (d < SPAWN_MIN || d > SPAWN_MAX || !clearOfPlayers(sim, mx, my, PLAYER_CLEARANCE)) continue;
    const angle = Math.atan2(pts[pts.length - 1] - pts[1], pts[pts.length - 2] - pts[0]);
    // at the kerb, to the right of the direction of travel
    const off = linkPoints(link, link.edge.width / 2 - 1);
    const ox = (off[0] + off[off.length - 2]) / 2, oy = (off[1] + off[off.length - 1]) / 2;
    if (w.spawnLevel(ox, oy, SPECS.van.width / 2, angle) !== 0) continue; // not a tunnel or deck
    if (!clearOfWalls(sim, ox, oy, angle)) continue; // not inside a building
    return { x: ox, y: oy, angle };
  }
  return null;
}

class Kofolka extends TimedEvent {
  private van: Vehicle;
  private pot = POT;
  private payTimer = 0;
  private earned = new Map<number, number>();
  private lastHolder = 0;
  private lastHolderAnnounceAt = -1e9;
  private everTaken = false;
  private place: string;
  private placeAt: number;

  constructor(sim: Sim, director: WorldEvents, id: number, spot: Spot) {
    super(sim, director, id, 'kofolka', ANNOUNCE_S, LIVE_MAX_S);
    const v = new Vehicle('van', spot.x, spot.y, spot.angle, KOFOLKA_RED);
    v.mission = true; // exempt from AI despawn/thinning
    v.livery = LIVERY_KOFOLKA;
    v.parked = true;
    sim.addVehicle(v);
    this.van = v;
    this.place = placeName(sim.world, spot.x, spot.y);
    this.placeAt = sim.time;
    sim.events.global({ k: 'eventAnnounce', kind: 'kofolka', x: spot.x, y: spot.y, secs: ANNOUNCE_S });
  }

  protected onLive() {
    this.sim.events.global({ k: 'eventStart', kind: 'kofolka', x: this.van.x, y: this.van.y });
  }

  update(dt: number): boolean {
    this.tick(dt);
    const sim = this.sim;
    if (!sim.vehicleById(this.van.id)) return false; // gone (sank, or swept): end quietly, nothing to clean up
    if (this.van.wrecked) return this.endWrecked();
    if (this.phase === 'live' && this.left <= 0) return this.endExpired(); // 8 min live
    if (this.phase !== 'live') return true;

    const owner = this.van.owner;
    if (owner) {
      const holder = sim.players.get(owner);
      if (holder) {
        if (owner !== this.lastHolder) {
          this.lastHolder = owner;
          this.everTaken = true;
          if (sim.time - this.lastHolderAnnounceAt >= HOLDER_ANNOUNCE_GAP) {
            this.lastHolderAnnounceAt = sim.time;
            sim.events.global({ k: 'holder', kind: 'kofolka', nick: holder.nick, x: this.van.x, y: this.van.y });
            this.director.changed();
          }
        }
        this.payTimer += dt;
        while (this.payTimer >= 1 && this.pot > 0) {
          this.payTimer -= 1;
          const amount = Math.min(PAYOUT_PER_SEC, this.pot);
          this.pot -= amount;
          this.earned.set(owner, (this.earned.get(owner) ?? 0) + amount);
          sim.payout(holder, amount, 'kofolka', this.van.x, this.van.y);
        }
      }
    } else this.payTimer = 0; // nobody driving: don't bank fractional seconds for whoever takes it next

    if (this.pot <= 0) return this.endWon();
    if (!this.everTaken && LIVE_MAX_S - this.left >= UNTAKEN_TIMEOUT_S) return this.endExpired(); // 3 min untaken

    if (sim.time - this.placeAt >= PLACE_REFRESH) {
      this.placeAt = sim.time;
      this.place = placeName(sim.world, this.van.x, this.van.y);
    }
    return true;
  }

  private topEarner(): { id: number; amount: number } | null {
    let best: { id: number; amount: number } | null = null;
    for (const [id, amount] of this.earned) if (!best || amount > best.amount) best = { id, amount };
    return best;
  }

  private endWon(): false {
    const top = this.topEarner();
    const winner = top ? this.sim.players.get(top.id)?.nick : undefined;
    this.sim.events.global({ k: 'eventEnd', kind: 'kofolka', how: 'won', winner, amount: top ? Math.round(top.amount) : 0, x: this.van.x, y: this.van.y });
    this.retire();
    return false;
  }

  private endWrecked(): false {
    const sim = this.sim, v = this.van;
    if (this.pot >= SPILL_MIN_POT) {
      const n = Math.min(SPILL_MAX_PICKUPS, Math.max(1, Math.round(this.pot / 150)));
      let left = Math.round(this.pot);
      for (let i = 0; i < n; i++) {
        const amount = i === n - 1 ? left : Math.round(this.pot / n);
        left -= amount;
        const a = sim.rng.next() * Math.PI * 2, r = sim.rng.range(2, 5);
        sim.dropCash(v.x + Math.cos(a) * r, v.y + Math.sin(a) * r, amount);
      }
    }
    sim.events.global({ k: 'eventEnd', kind: 'kofolka', how: 'wrecked', x: v.x, y: v.y });
    this.retire();
    return false;
  }

  private endExpired(): false {
    this.sim.events.global({ k: 'eventEnd', kind: 'kofolka', how: 'expired', x: this.van.x, y: this.van.y });
    this.retire();
    return false;
  }

  /** back to an ordinary van: no more mission exemption, no more paint job */
  private retire() {
    const v = this.van;
    v.mission = false;
    v.livery = LIVERY_NONE;
    v.rev++;
  }

  entry(): EventEntry {
    const owner = this.van.owner;
    return {
      id: this.id, kind: 'kofolka', phase: this.phase, left: Math.max(0, this.left),
      x: this.van.x, y: this.van.y, holder: owner || undefined, holderNick: owner ? this.sim.players.get(owner)?.nick : undefined,
      pot: Math.round(this.pot), vid: this.van.id, place: this.place,
    };
  }

  stop() {
    if (this.sim.vehicleById(this.van.id)) this.retire();
  }
}

export const KOFOLKA_DEF: WorldEventDef = {
  kind: 'kofolka',
  minPlayers: 2,
  offline: false,
  scheduled: true,
  weight: 1,
  cooldown: 1200,
  create(sim, director, id) {
    const c = centroidOf(sim);
    if (!c) return null;
    const spot = findSpot(sim, c.x, c.y);
    if (!spot) return null;
    return new Kofolka(sim, director, id, spot);
  },
};
