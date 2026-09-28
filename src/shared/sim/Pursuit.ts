// The police's side of a chase, per wanted player (docs/plans/gameplay.md, Phase 1).
//
// - Who sees the player: police cars in the chase and cops on foot, each through a cone that
//   darkness and rain shorten, and the helicopter (by day the circle under it, after dark its beam;
//   never under a roof, a passage or a bridge deck). See sight.ts.
// - What the police are looking for: the description, the car they last saw the player in (or "on
//   foot"). A player who matches it is seen as soon as a unit has them in sight; one who doesn't (a
//   different car, a new colour, on foot) only once a unit has watched them long enough, or at once
//   up close.
// - Where they look when nobody sees the player: the search circle round where they were last seen
//   (the units in AI.ts and Police.ts search it rather than homing in).
// - Lying low: still and out of sight, the stars fade faster, even inside the circle.
// - Buying off an arrest (Úplatok).
//
// Runs wherever the Sim does (offline in the page, online on the server); the client hears about it
// through the `police` and `bribe` private events.
import type { VehicleKind } from '../entities/Vehicle';
import type { Level } from '../world/World';
import { clamp, dist, hypot } from '../util/math';
import { DARK_CAR, SIGHT, inSight, sightEnv, type SightEnv } from './sight';
import type { Sim } from './Sim';
import type { PlayerState, SimPlayer } from './SimPlayer';

/** what the police are looking for: the car they last saw the player in (its id, 0: on foot), and its
 *  kind and colour then (for the HUD and the police radio). On foot, `color` is the jacket's and `hat`
 *  what they had on their head (docs/plans/gameplay.md, Phase 2: new clothes are a new description). */
export interface Desc {
  car: number;
  kind: VehicleKind | null;
  color: string;
  hat?: number;
}

/** below this speed (m/s) a player is standing still */
const STILL_SPEED = 0.6;
/** seconds still, out of sight, before a player is lying low */
export const LOW_AFTER = 3;
/** a player who doesn't match the description is recognised after this long in a unit's sight (s):
 *  a base plus this much per metre away, twice as long while they lie low */
const RECOGNISE_BASE = 1;
const RECOGNISE_PER_M = 1 / 20;
const RECOGNISE_LOW = 2;
/** ...and twice as long again for a rider among a tram's passengers, even one who matches
 *  (rules/Trams.ts) */
const RECOGNISE_RIDING = 2;
/** with nobody watching, recognition falls back this fast (per s) */
const SPOT_DECAY = 0.4;
/** how far the helicopter counts as being, for recognising someone (m) */
const HELI_RECOGNISE_D = 30;
/** gunfire this close to a police unit is heard, whichever way it faces (m) */
export const HEAR_SHOT = 20;
/** the unseen timer runs this much faster while the player doesn't match the description (×), and
 *  this much more lying low, and more again in a hideout (+), but never faster than FADE_MAX */
export const FADE_MISMATCH = 1.4;
export const FADE_LOW = 0.4;
export const FADE_HIDEOUT = 0.4;
export const FADE_MAX = 2.2;
/** the search circle: where it starts (m), how fast it grows (m/s), how big it gets (m) */
const ZONE_R0 = 40;
const ZONE_GROW = 4;
const ZONE_MAX = 120;
/** roadblocks and spike strips go up only while the police see the player, or saw them this
 *  recently (s): they're put ahead of where the player was heading */
export const FRESH_SIGHTING = 5;
/** Úplatok: offered on an arrest at up to this many stars, for this much per star; the arrest waits
 *  this long (s) for the money instead of the usual 4 s; one bribe per this long (s) */
export const BRIBE_MAX_STARS = 2;
export const BRIBE_PER_STAR = 150;
export const BRIBE_WAIT = 5;
export const BRIBE_COOLDOWN = 600;

/** a unit's view of the player this step: the nearest that has them in sight, and whether any has
 *  them within its close range */
interface Look {
  /** -1: nobody */
  d: number;
  close: boolean;
}

export class Pursuit {
  private envNow: SightEnv = { dark: 0, scale: 1 };
  private envAt = NaN;

  constructor(private sim: Sim) {}

  /** light and weather as the police's eyes feel them (worked out once per sim step) */
  env(): SightEnv {
    const sim = this.sim;
    if (this.envAt !== sim.time) {
      this.envAt = sim.time;
      this.envNow = sightEnv(sim.clock.time, sim.clock.rain);
    }
    return this.envNow;
  }

  /** the description the police would give of `p` right now: the car they're in, or on foot */
  current(p: SimPlayer): Desc {
    const v = p.ped.vehicle;
    return v ? { car: v.id, kind: v.kind, color: v.color } : { car: 0, kind: null, color: p.ped.shirt, hat: p.ped.hat };
  }

  /** does `p` look like what the police are looking for? On foot: the same jacket and hat (a
   *  description from before anyone noted the clothes matches anyone on foot) */
  matches(p: SimPlayer): boolean {
    const v = p.ped.vehicle, d = p.desc;
    if (v) return v.id === d.car && v.color === d.color;
    return d.car === 0 && (!d.color || (d.color === p.ped.shirt && (d.hat ?? 0) === p.ped.hat));
  }

  /** The police know where `p` is and what they're in: a crime, a sighting, a mission or event
   *  making them wanted. Or, for a witness's report, where the crime happened (`at`) and what they
   *  were in then (`desc`). The search starts over from there. `sighted`: they see the player right
   *  now (so roadblocks may go up ahead of them). */
  know(p: SimPlayer, at?: { x: number; y: number }, desc?: Desc, sighted = true) {
    const f = at ?? p.focus();
    p.lastSeenPos = { x: f.x, y: f.y };
    p.desc = desc ?? this.current(p);
    p.unseen = 0;
    if (sighted) {
      p.lastSeenAt = this.sim.time;
      p.searchZone = null;
    } else {
      // only told (a witness's report): nobody has eyes on the player, so the search starts at once
      p.searchZone = { x: f.x, y: f.y, r: ZONE_R0 };
      p.searching = true;
    }
  }

  /** where `p` is out of sight for good measure: a car among the parked ones in a car park, or
   *  anyone under cover (a passage, a roof, a bridge deck, a tunnel) */
  hideout(p: SimPlayer): boolean {
    const f = p.focus();
    const w = this.sim.world;
    return (!!p.ped.vehicle && w.inParking(f.x, f.y)) || w.covered(f.x, f.y, p.focusLevel());
  }

  /** Is a police unit watching `p` right now: a police car with someone at the wheel (patrolling or
   *  chasing) or a cop on foot with them in sight, or within `hear` m of them (gunfire)? A crime
   *  committed now is seen by the police. */
  policeWatching(p: SimPlayer, hear = 0): boolean {
    return this.look(p, true, 1, hear).d >= 0;
  }

  /** Who of the police sees `p`. `anyCar`: every police car with a driver (for a crime), else only
   *  those in a chase (siren on). `target` scales every range but the close ones (a dark parked car).
   *  `hear`: any unit this close notices, whichever way it faces (m). */
  private look(p: SimPlayer, anyCar: boolean, target: number, hear = 0): Look {
    const sim = this.sim;
    const world = sim.world;
    const env = this.env();
    const f = p.focus();
    const fl = p.focusLevel();
    // nobody on the surface sees into a tunnel, nor out of one
    const sightOk = (level: Level) => (level === -1) === (fl === -1);
    const out: Look = { d: -1, close: false };
    const saw = (d: number, near: number) => {
      if (out.d < 0 || d < out.d) out.d = d;
      if (d <= near) out.close = true;
    };
    sim.forVehiclesNear(f.x, f.y, SIGHT.car.range + 5, (v) => {
      if (v.wrecked || v.isPlayer || !v.driver || v.driver.dazed || v.driver.leaving || !(anyCar || v.siren) || !sightOk(v.level)) return;
      if (v.kind !== 'police' && v.kind !== 'policeboat' && !sim.police.swat.has(v)) return;
      const heard = dist(v.x, v.y, f.x, f.y);
      if (heard <= hear) return saw(heard, SIGHT.car.near);
      const d = inSight(v.x, v.y, v.angle, SIGHT.car, env.scale, f.x, f.y, target);
      if (d >= 0 && world.raycast(v.x, v.y, f.x, f.y, fl) >= 1) saw(d, SIGHT.car.near);
    });
    sim.forPedsNear(f.x, f.y, Math.max(hear, SIGHT.foot.range + 3), (c) => {
      // (a cop knocked down, or up again and off duty, isn't looking: docs/plans/non-violent.md)
      if (c.kind !== 'cop' || c.dazed || c.leaving || c.vehicle || !sightOk(c.level)) return;
      const heard = dist(c.x, c.y, f.x, f.y);
      if (heard <= hear) return saw(heard, SIGHT.foot.near);
      const d = inSight(c.x, c.y, c.angle, SIGHT.foot, env.scale, f.x, f.y, target);
      if (d >= 0 && world.raycast(c.x, c.y, f.x, f.y, fl) >= 1) saw(d, SIGHT.foot.near);
    });
    if (!anyCar && fl !== -1 && !world.covered(f.x, f.y, fl))
      for (const h of sim.police.helis()) if (h.sees(f.x, f.y, env.dark)) saw(HELI_RECOGNISE_D, 0);
    return out;
  }

  /** Once per step for each player who's playing: who sees them, recognition, lying low, the search
   *  circle and the stars fading. */
  update(p: SimPlayer, dt: number) {
    const sim = this.sim;
    const car = p.ped.vehicle;
    const speed = car ? car.speed : hypot(p.ped.vx, p.ped.vy);
    p.still = speed < STILL_SPEED ? p.still + dt : 0;
    if (p.wanted <= 0) {
      p.searchZone = null;
      p.searching = false;
      p.spot = 0;
      p.low = 0;
      // the stars went some other way than a getaway (a respawn, the spray shop, a bribe, the
      // derby's amnesty): that chase is over without points
      p.chaseSince = -1;
      p.chasePeak = 0;
      this.status(p, false);
      return;
    }
    if (p.chaseSince < 0) p.chaseSince = sim.time;
    p.chasePeak = Math.max(p.chasePeak, p.stars);
    const f = p.focus();
    const env = this.env();
    const matches = this.matches(p);
    // a still car after dark has its lights off: it's hard to make out among the parked ones
    const target = car && p.still >= LOW_AFTER && env.dark > 0.5 ? DARK_CAR : 1;
    const look = this.look(p, false, target);
    const riding = !!p.ped.aboard && p.ped.aboard.driver !== p.id;
    let seen = false;
    if (look.d >= 0) {
      if ((matches || look.close) && !riding) seen = true;
      else {
        // someone's looking at a player who isn't what they were told to look for (or is one face
        // among a tram's passengers): it takes a while
        const t = (RECOGNISE_BASE + look.d * RECOGNISE_PER_M) * (p.low ? RECOGNISE_LOW : 1) * (riding ? RECOGNISE_RIDING : 1);
        p.spot = Math.min(1, p.spot + dt / t);
        seen = p.spot >= 1;
      }
    } else p.spot = Math.max(0, p.spot - dt * SPOT_DECAY);

    if (seen) {
      p.spot = 1;
      p.low = 0;
      p.unseen = 0;
      p.lastSeenPos = { x: f.x, y: f.y };
      p.lastSeenAt = sim.time;
      p.searchZone = null;
      // recognised in something new: that's what they look for from now on
      if (!matches) p.desc = this.current(p);
    } else {
      p.low = p.still >= LOW_AFTER ? (this.hideout(p) ? 2 : 1) : 0;
      if (!p.searchZone) p.searchZone = { x: p.lastSeenPos.x, y: p.lastSeenPos.y, r: ZONE_R0 };
      else p.searchZone.r = Math.min(ZONE_MAX, p.searchZone.r + dt * ZONE_GROW);
      // while a unit is looking them over, the stars hold
      if (look.d < 0) {
        let rate = matches ? 1 : FADE_MISMATCH;
        if (p.low >= 1) rate += FADE_LOW;
        if (p.low >= 2) rate += FADE_HIDEOUT;
        p.unseen += dt * Math.min(FADE_MAX, rate);
      }
      const z = p.searchZone;
      const outside = dist(f.x, f.y, z.x, z.y) > z.r;
      if ((outside || p.low > 0) && p.unseen > 9 + Math.ceil(p.wanted) * 1.5) {
        p.unseen = 0;
        p.wanted = Math.max(0, Math.ceil(p.wanted) - 1);
        p.heat = 0;
        if (p.wanted === 0) {
          p.shotCops = false;
          p.searchZone = null;
          p.spot = 0;
          p.low = 0;
          sim.events.toPlayer(p.id, { k: 'msg', title: '', text: 'Polícia ťa stratila z dohľadu.', time: 2, color: '#90caf9' });
          sim.getaway(p);
        }
      }
    }
    p.searching = !seen && p.wanted > 0;
    this.status(p, look.d >= 0 && !seen);
  }

  /** Tell the player what the police know (the `police` private event), when it changes: the
   *  description, whether they match it, recognition (0..1, in tenths) and whether a unit is looking
   *  them over, and lying low (0, 1, 2 in a hideout). */
  private status(p: SimPlayer, watched: boolean) {
    if (p.wanted <= 0) {
      if (p.policeKey !== 'off') {
        p.policeKey = 'off';
        this.sim.events.toPlayer(p.id, { k: 'police', car: -1, kind: '', color: '', m: 1, spot: 0, w: 0, low: 0 });
      }
      return;
    }
    const m = this.matches(p) ? 1 : 0, w = watched ? 1 : 0;
    const spot = Math.round(clamp(p.spot, 0, 1) * 10) / 10;
    const key = `${p.desc.car}|${p.desc.color}|${p.desc.hat ?? 0}|${m}|${spot}|${w}|${p.low}`;
    if (key === p.policeKey) return;
    p.policeKey = key;
    this.sim.events.toPlayer(p.id, { k: 'police', car: p.desc.car, kind: p.desc.kind ?? '', color: p.desc.color, hat: p.desc.hat, m, spot, w, low: p.low });
  }

  // ---------------------------------------------------------------- Úplatok
  /** An arrest (Sim.bust) the police may let go for money: at 1–2 stars, from a player who hasn't
   *  shot at them and hasn't bought one off in the last 10 minutes. Returns whether it was offered
   *  (the arrest then waits BRIBE_WAIT s for the money). */
  offerBribe(p: SimPlayer, from: PlayerState): boolean {
    const sim = this.sim;
    p.bribeOffer = 0;
    // a player cuffed where they lay wounded (Revive) is in no state to haggle
    if (from !== 'play' || p.stars < 1 || p.stars > BRIBE_MAX_STARS || p.shotCops) return false;
    if (sim.time - p.bribeAt < BRIBE_COOLDOWN) {
      sim.events.toPlayer(p.id, { k: 'msg', title: '', text: 'Úplatok? Tentoraz ti to neprejde.', time: 3, color: '#ff8a80' });
      return false;
    }
    p.bribeOffer = BRIBE_PER_STAR * p.stars;
    sim.events.toPlayer(p.id, { k: 'bribe', price: p.bribeOffer, t: BRIBE_WAIT });
    return true;
  }

  /** Whether `p` can pay the bribe on offer now; says why not. */
  canBribe(p: SimPlayer): boolean {
    if (p.state !== 'busted' || !p.bribeOffer) return false;
    if (p.profile.money >= p.bribeOffer) return true;
    this.sim.events.toPlayer(p.id, { k: 'msg', title: '', text: `Na úplatok nemáš (€${p.bribeOffer}).`, time: 3, color: '#ff8a80' });
    return false;
  }
}
