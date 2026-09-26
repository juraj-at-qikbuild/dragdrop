// Derby na parkovisku: a demolition derby in a parking-lot arena, alternating between Aupark and
// Eurovea each time it runs. Six unlocked classic cars wait inside the ring; whoever is driving in
// the arena the moment the announce ends is a participant. Wanted stars are suspended for anyone
// inside the arena while it's live (participants and any bystander alike), and a participant is
// knocked out by a wrecked car, going on foot, straying outside for more than 3 s, or leaving. The
// last one standing — or the healthiest car at the 3-minute mark — takes the pot.
// Plan: docs/plans/social-events.md
import type { Sim } from '../../Sim';
import type { SimPlayer } from '../../SimPlayer';
import { LIVERY_DERBY, LIVERY_NONE, SPECS, Vehicle } from '../../../entities/Vehicle';
import { bboxOf, dist, pointInRings, segDist2 } from '../../../util/math';
import { TimedEvent, type WorldEventDef, type WorldEvents } from '../WorldEvents';
import type { EventEntry } from '../types';
import { placeName } from '../placeName';
import { bestParkingNear, Zones } from '../Zones';

type Site = 'aupark' | 'eurovea';

const ANNOUNCE_S = 90;
const LIVE_S = 3 * 60;
const ARENA_MAX_DIST = 250;
const CAR_KIND = 'classic';
const CAR_COUNT = 6;
/** the car's circumscribed radius: a spot at least this far from every wall and every other car's
 *  centre always has room for the whole (rotated) rectangle, whichever way it's facing */
const CAR_RADIUS = Math.hypot(SPECS[CAR_KIND].length / 2, SPECS[CAR_KIND].width / 2);
/** clearance kept from the arena's own edge, beyond the car's radius */
const WALL_MARGIN = 1.5;
/** clearance kept between two cars, beyond their radii (tight: a derby wants them close together) */
const CAR_CLEARANCE = 1.2;
const SPOT_TRIES = 500;
/** the amnesty/elimination poll (2-4 Hz asked for; this is every 0.25 s) */
const CHECK_INTERVAL = 0.25;
const OUTSIDE_LIMIT_S = 3;
const HEALTH_ELIM_FRAC = 0.1;
const POT_PER_PLAYER = 300;
const POT_MAX = 2400;
const SPLIT = [0.6, 0.25, 0.15];

/** the last site used, per Sim, so consecutive derbies alternate (module-level: the Sim keeps no
 *  memory of its own between one event instance and the next) */
const lastSite = new WeakMap<Sim, Site>();
function nextSite(sim: Sim): Site {
  const site: Site = lastSite.get(sim) === 'aupark' ? 'eurovea' : 'aupark';
  lastSite.set(sim, site);
  return site;
}

/** shortest distance from (x, y) to the ring's own boundary (as opposed to inside/outside it) */
function edgeDist(x: number, y: number, ring: number[]): number {
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const d2 = segDist2(x, y, ring[i], ring[i + 1], ring[j], ring[j + 1]);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

interface Spot {
  x: number;
  y: number;
  angle: number;
}

/** Up to `count` spots inside `ring`: clear of its edge, of walls, and of each other, at level 0.
 *  Fewer than `count` come back when the lot is too small or too built up to fit them all. */
function findCarSpots(sim: Sim, ring: number[], count: number): Spot[] {
  const w = sim.world;
  const b = bboxOf(ring);
  const spots: Spot[] = [];
  for (let tries = 0; tries < SPOT_TRIES && spots.length < count; tries++) {
    const x = sim.rng.range(b.x0 + CAR_RADIUS, b.x1 - CAR_RADIUS);
    const y = sim.rng.range(b.y0 + CAR_RADIUS, b.y1 - CAR_RADIUS);
    if (!pointInRings(x, y, [ring]) || edgeDist(x, y, ring) < CAR_RADIUS + WALL_MARGIN) continue;
    if (spots.some((s) => dist(x, y, s.x, s.y) < CAR_RADIUS * 2 + CAR_CLEARANCE)) continue;
    const angle = sim.rng.next() * Math.PI * 2;
    if (w.collideCircle(x, y, CAR_RADIUS, 0)) continue;
    if (w.spawnLevel(x, y, CAR_RADIUS, angle) !== 0) continue;
    spots.push({ x, y, angle });
  }
  return spots;
}

interface Participant {
  id: number;
  nick: string;
  active: boolean;
  /** sim.time this participant's car first strayed outside the arena; null while inside (or while a
   *  different rule already knocked them out) */
  outsideSince: number | null;
}

class Derby extends TimedEvent {
  private cars: Vehicle[];
  private zones = new Zones();
  private place: string;
  /** everyone currently inside the arena while it's live (participants and any bystander alike): the
   *  wanted level they came in with, restored the moment they leave (or the event ends) */
  private amnesty = new Map<number, number>();
  private participants: Participant[] = [];
  /** knocked-out participants, oldest first (reversed for the final order and the payout) */
  private eliminated: Participant[] = [];
  private pot = 0;
  private pollTimer = CHECK_INTERVAL;
  private cancelled = false;
  private done = false;

  constructor(
    sim: Sim,
    director: WorldEvents,
    id: number,
    private readonly ring: number[],
    private readonly cx: number,
    private readonly cy: number,
    spots: Spot[],
  ) {
    super(sim, director, id, 'derby', ANNOUNCE_S, LIVE_S);
    this.zones.add('derby', [ring], 'derby');
    this.place = placeName(sim.world, cx, cy);
    this.cars = spots.map((s) => {
      const spec = SPECS[CAR_KIND];
      const v = new Vehicle(CAR_KIND, s.x, s.y, s.angle, sim.rng.pick(spec.colors));
      v.mission = true; // exempt from AI despawn/thinning, same as Kofolka's van
      v.livery = LIVERY_DERBY;
      v.parked = true;
      sim.addVehicle(v);
      return v;
    });
    sim.events.global({ k: 'eventAnnounce', kind: 'derby', x: cx, y: cy, secs: ANNOUNCE_S });
  }

  private inArena(x: number, y: number): boolean {
    return this.zones.inZone('derby', x, y);
  }

  /** no stars for anything done while inside the live arena (checked live, not off the amnesty poll,
   *  so it can't lag behind: a hit lands and is judged in the same tick) */
  allowCrime(p: SimPlayer): boolean {
    if (this.phase !== 'live') return true;
    const f = p.focus();
    return !this.inArena(f.x, f.y);
  }

  /** the announce is over: whoever's driving inside the arena right now is in the derby */
  protected onLive() {
    const sim = this.sim;
    const found: Participant[] = [];
    for (const p of sim.players.values()) {
      const v = p.ped.vehicle;
      if (!p.connected || !v || !this.inArena(v.x, v.y)) continue;
      found.push({ id: p.id, nick: p.nick, active: true, outsideSince: null });
    }
    if (found.length < 2) {
      this.cancelled = true;
      return;
    }
    this.participants = found;
    this.pot = Math.min(POT_MAX, POT_PER_PLAYER * found.length);
    sim.events.global({ k: 'eventStart', kind: 'derby', x: this.cx, y: this.cy });
    this.pollAmnesty();
  }

  update(dt: number): boolean {
    this.tick(dt);
    if (this.cancelled) return this.endCancelled();
    if (this.done) return false;
    if (this.phase !== 'live') return true;
    this.pollTimer -= dt;
    if (this.pollTimer > 0) return true;
    this.pollTimer = CHECK_INTERVAL;
    this.pollAmnesty();
    this.pollEliminations();
    return !this.done;
  }

  /** the 3-minute mark: rank whoever's left by health % */
  protected onTimeout() {
    this.finishRound();
  }

  /** any player (not just a participant, but never the most wanted target) whose focus is inside the
   *  arena has their wanted level put on loan for as long as they stay; the moment they're no longer
   *  inside, it comes back */
  private pollAmnesty() {
    const sim = this.sim;
    // the most wanted player gets no amnesty: the whole city is after them, and zeroed stars would
    // let them sit out the escape countdown in here (rules/events/MostWanted.ts)
    const hunted = this.director.get('wanted')?.entry().holder;
    for (const p of sim.players.values()) {
      const f = p.focus();
      const inside = this.inArena(f.x, f.y) && p.id !== hunted;
      if (inside && !this.amnesty.has(p.id)) {
        this.amnesty.set(p.id, p.wanted);
        sim.setWanted(p, 0);
      } else if (!inside && this.amnesty.has(p.id)) {
        const wanted = this.amnesty.get(p.id)!;
        this.amnesty.delete(p.id);
        sim.setWanted(p, wanted);
      }
    }
  }

  private pollEliminations() {
    const sim = this.sim;
    for (const pt of this.participants) {
      if (!pt.active) continue;
      const p = sim.players.get(pt.id);
      if (!p || !p.connected) {
        this.eliminate(pt);
        continue;
      }
      const v = p.ped.vehicle;
      if (!v) {
        this.eliminate(pt);
        continue;
      }
      if (v.wrecked || v.health <= v.spec.health * HEALTH_ELIM_FRAC) {
        this.eliminate(pt);
        continue;
      }
      if (this.inArena(v.x, v.y)) pt.outsideSince = null;
      else if (pt.outsideSince === null) pt.outsideSince = sim.time;
      else if (sim.time - pt.outsideSince > OUTSIDE_LIMIT_S) this.eliminate(pt);
    }
    if (this.participants.filter((p) => p.active).length <= 1) this.finishRound();
  }

  private eliminate(pt: Participant) {
    pt.active = false;
    this.eliminated.push(pt);
    this.director.changed(); // the HUD's "N áut" count just changed
  }

  /** a participant left the world for good: knock them out right away, rather than waiting for the
   *  next poll to notice sim.players no longer has them */
  onRemove(p: SimPlayer) {
    this.amnesty.delete(p.id);
    const pt = this.participants.find((x) => x.id === p.id && x.active);
    if (!pt) return;
    this.eliminate(pt);
    if (this.phase === 'live' && !this.done && this.participants.filter((x) => x.active).length <= 1) this.finishRound();
  }

  private healthFrac(pt: Participant): number {
    const v = this.sim.players.get(pt.id)?.ped.vehicle;
    return v ? v.health / v.spec.health : 0;
  }

  /** the last car standing, or (at the timeout) the healthiest survivor(s) first; everyone else
   *  follows in reverse elimination order (most recently knocked out ranks highest) */
  private finishRound() {
    if (this.done) return;
    this.done = true;
    const sim = this.sim;
    const survivors = this.participants.filter((p) => p.active).sort((a, b) => this.healthFrac(b) - this.healthFrac(a));
    const order = [...survivors, ...[...this.eliminated].reverse()];
    const winners: string[] = [];
    for (let i = 0; i < order.length && i < SPLIT.length; i++) {
      const amount = Math.round(this.pot * SPLIT[i]);
      if (amount <= 0) continue;
      const pt = order[i];
      winners.push(pt.nick);
      const p = sim.players.get(pt.id);
      if (!p) continue; // left for good: nobody to pay, but they still get their spot in the news
      sim.payout(p, amount, 'derby', this.cx, this.cy);
      if (i === 0) {
        const stats = (p.profile.stats ??= {});
        stats.derbyWins = (stats.derbyWins ?? 0) + 1;
        sim.onProfileChange?.(p);
      }
    }
    sim.events.global({ k: 'derbyResult', winners, place: this.place });
    this.cleanup();
  }

  private endCancelled(): false {
    if (!this.done) {
      this.done = true;
      this.sim.events.global({ k: 'eventEnd', kind: 'derby', how: 'cancelled', x: this.cx, y: this.cy });
      this.cleanup();
    }
    return false;
  }

  /** restore whatever wanted levels are still on loan, drop the zone, and hand the cars back (like
   *  Kofolka's own retire(): no more mission exemption, no more paint job) */
  private cleanup() {
    const sim = this.sim;
    for (const [id, wanted] of this.amnesty) {
      const p = sim.players.get(id);
      if (p) sim.setWanted(p, wanted);
    }
    this.amnesty.clear();
    this.zones.remove('derby');
    for (const v of this.cars) {
      v.mission = false;
      v.livery = LIVERY_NONE;
      v.rev++;
    }
  }

  entry(): EventEntry {
    const live = this.phase === 'live';
    return {
      id: this.id, kind: 'derby', phase: this.phase, left: Math.max(0, this.left),
      x: this.cx, y: this.cy, zone: this.ring,
      alive: live ? this.participants.filter((p) => p.active).length : this.cars.length,
      pot: live ? this.pot : POT_PER_PLAYER * 3,
      place: this.place,
    };
  }

  stop() {
    if (this.done) return;
    this.done = true;
    this.cleanup();
  }
}

export const DERBY_DEF: WorldEventDef = {
  kind: 'derby',
  minPlayers: 3,
  offline: false,
  scheduled: true,
  weight: 0.8,
  cooldown: 1800,
  create(sim, director, id) {
    const site = nextSite(sim);
    const arena = bestParkingNear(sim.world, site, ARENA_MAX_DIST);
    if (!arena) return null;
    const spots = findCarSpots(sim, arena.ring, CAR_COUNT);
    if (spots.length < CAR_COUNT) return null;
    return new Derby(sim, director, id, arena.ring, arena.cx, arena.cy, spots);
  },
};
