// Hon na Čumila: a golden Čumil statue pops out of a manhole somewhere in the city. The map shows only
// a shrinking hint circle (never the exact spot), gold on the minimap; the first to touch the statue,
// on foot or in a car, wins the pot. Runs online and offline (single-player included).
// Plan: docs/plans/social-events.md
import type { Sim } from '../../Sim';
import type { SimPlayer } from '../../SimPlayer';
import type { Pickup } from '../../Pickups';
import { dist } from '../../../util/math';
import { TimedEvent, type WorldEventDef, type WorldEvents } from '../WorldEvents';
import type { EventEntry } from '../types';
import { placeName } from '../placeName';
import { centroidOf, clearOfPlayers } from './placement';

const ANNOUNCE_S = 30;
const LIVE_S = 7 * 60;
const TARGET_MIN = 400, TARGET_MAX = 1200;
const PLAYER_CLEARANCE = 150;
const REWARD = 600;
/** the hint circle: 450 m shrinking to 30 m in 6 even steps over 5 min */
const CIRCLE_START = 450, CIRCLE_END = 30, CIRCLE_STEPS = 6, CIRCLE_DURATION_S = 5 * 60;
/** re-centre offset each step, as a fraction of the (new, smaller) radius: keeps the target inside */
const CIRCLE_JITTER = 0.6;
/** `entry().place` is recomputed at most this often */
const PLACE_REFRESH = 10;

/** A ped-graph node `TARGET_MIN`..`TARGET_MAX` m from (cx, cy), at least `PLAYER_CLEARANCE` m from
 *  every player, walkable, at level 0 and dry (Pickups.ts places the ten fixed Čumils on this same
 *  graph, minus the distance-from-players and level/water checks this live-RNG spot also needs). */
function findTarget(sim: Sim, cx: number, cy: number): { x: number; y: number } | null {
  const w = sim.world;
  const nodes = w.ped.nodesAround(cx, cy, TARGET_MIN, TARGET_MAX);
  for (let tries = 0; tries < 40 && nodes.length; tries++) {
    const n = sim.rng.pick(nodes);
    const x = w.ped.nx(n), y = w.ped.ny(n);
    if (!clearOfPlayers(sim, x, y, PLAYER_CLEARANCE)) continue;
    const wk = w.walkableNear(x, y);
    if (dist(wk.x, wk.y, x, y) > 2) continue;
    if (w.spawnLevel(x, y, 0.4) !== 0) continue;
    if (w.inWater(x, y, 0)) continue;
    return { x, y };
  }
  return null;
}

class CumilHunt extends TimedEvent {
  private pickup: Pickup | null = null;
  private target: { x: number; y: number };
  private circleX: number;
  private circleY: number;
  private circleR = CIRCLE_START;
  private circleStep = 0;
  private place: string;
  private placeAt: number;
  private done = false;

  constructor(sim: Sim, director: WorldEvents, id: number, target: { x: number; y: number }) {
    super(sim, director, id, 'cumil', ANNOUNCE_S, LIVE_S);
    this.target = target;
    // Everything that leaves the server (the circle, the announce/start positions, the place name)
    // comes from the jittered circle, never the target: the statue itself is only sent within 40 m.
    this.circleX = target.x;
    this.circleY = target.y;
    this.recentre();
    this.place = placeName(sim.world, this.circleX, this.circleY);
    this.placeAt = sim.time;
    sim.events.global({ k: 'eventAnnounce', kind: 'cumil', x: this.circleX, y: this.circleY, secs: ANNOUNCE_S });
  }

  protected onLive() {
    const sim = this.sim;
    this.pickup = { id: sim.ids.alloc(sim.time), x: this.target.x, y: this.target.y, kind: 'goldenCumil', amount: REWARD, respawn: 0, hidden: 0, cumil: -1, tag: 'cumilHunt' };
    sim.pickups.push(this.pickup);
    sim.events.global({ k: 'eventStart', kind: 'cumil', x: this.circleX, y: this.circleY });
  }

  /** a new circle centre up to `CIRCLE_JITTER` × the current radius from the target, so it still contains it */
  private recentre() {
    const a = this.sim.rng.next() * Math.PI * 2, r = this.sim.rng.next() * CIRCLE_JITTER * this.circleR;
    this.circleX = this.target.x + Math.cos(a) * r;
    this.circleY = this.target.y + Math.sin(a) * r;
  }

  update(dt: number): boolean {
    this.tick(dt);
    if (this.done) return false;
    if (this.phase === 'live' && this.left <= 0) {
      this.removePickup(); // timed out, unclaimed
      this.sim.events.global({ k: 'eventEnd', kind: 'cumil', how: 'expired', x: this.target.x, y: this.target.y });
      return false;
    }
    if (this.phase !== 'live') return true;

    const elapsed = LIVE_S - this.left;
    const wantStep = Math.min(CIRCLE_STEPS, Math.floor(elapsed / (CIRCLE_DURATION_S / CIRCLE_STEPS)));
    if (wantStep > this.circleStep) {
      this.circleStep = wantStep;
      this.circleR = CIRCLE_START * (CIRCLE_END / CIRCLE_START) ** (this.circleStep / CIRCLE_STEPS);
      this.recentre();
      this.director.changed();
    }
    if (this.sim.time - this.placeAt >= PLACE_REFRESH) {
      this.placeAt = this.sim.time;
      this.place = placeName(this.sim.world, this.circleX, this.circleY);
    }
    return true;
  }

  onPickup(p: SimPlayer, pk: Pickup) {
    if (pk !== this.pickup) return;
    const sim = this.sim;
    sim.payout(p, REWARD, 'cumil', pk.x, pk.y);
    const stats = (p.profile.stats ??= {});
    stats.golden = (stats.golden ?? 0) + 1;
    sim.onProfileChange?.(p);
    sim.events.global({ k: 'eventEnd', kind: 'cumil', how: 'won', winner: p.nick, amount: REWARD, x: pk.x, y: pk.y });
    // Sim.updatePickups() itself removes a taken one-off pickup from sim.pickups (respawn: 0); just
    // forget our own reference to it.
    this.pickup = null;
    this.done = true;
  }

  entry(): EventEntry {
    return { id: this.id, kind: 'cumil', phase: this.phase, left: Math.max(0, this.left), x: this.circleX, y: this.circleY, r: Math.round(this.circleR), place: this.place };
  }

  stop() {
    this.removePickup();
  }

  /** Sim.updatePickups() only sweeps a pickup it hides itself; hiding ours from outside that loop
   *  (a timeout, a debug/shutdown stop) would otherwise leave a dead entry in sim.pickups forever. */
  private removePickup() {
    if (!this.pickup) return;
    const i = this.sim.pickups.indexOf(this.pickup);
    if (i >= 0) this.sim.pickups.splice(i, 1);
    this.pickup = null;
  }
}

export const CUMIL_HUNT_DEF: WorldEventDef = {
  kind: 'cumil',
  minPlayers: 1,
  offline: true,
  scheduled: true,
  weight: 1.2,
  cooldown: 900,
  create(sim, director, id) {
    const c = centroidOf(sim);
    if (!c) return null;
    const target = findTarget(sim, c.x, c.y);
    if (!target) return null;
    return new CumilHunt(sim, director, id, target);
  },
};
