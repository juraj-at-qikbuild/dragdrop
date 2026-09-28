// Električkár (docs/plans/minigames.md): the tram driver. Petržalka's tram at last reached Janíkov
// dvor in July 2025, after decades of promises of a "metro", and cars parked on the tracks hold up
// Bratislava's trams all the time (once one rolled onto the tracks on Račianska with nobody in it).
//
// The player drives a tram from its cab (rules/Trams.ts: the throttle and the brake, the steering
// picks the branch at a junction, H the bell): the round puts one at the stop nearest them. The run
// is the next stops along the tracks — which way at a junction, the view says — each on a "metro
// interval" countdown: stop at it (the nose within a few metres of it) and the doors open for three
// seconds. Late costs; going past one costs more. Now and then a car stands on the track ahead: ring
// the bell near it and its driver comes back and moves it, call the tow truck (the action key:
// twenty seconds), or push on through and pay for the damage. With a second player, they drive the
// tow truck: next to a car on the track, the action key tows it away at once; the two share the pay.
// Six stops, or six minutes.
import { clamp, dist } from '../../../../util/math';
import { Ped } from '../../../../entities/Ped';
import { SPECS, Vehicle, type VehicleKind } from '../../../../entities/Vehicle';
import type { Tram } from '../../../../entities/Tram';
import { linkPoints, type Link } from '../../../../world/Graph';
import type { Sim, Crime } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { TRAM_STOPPED, type Trams } from '../../Trams';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';
import {
  Ways, branch, carrying, clearAhead, leadIn, leftHand, linksAt, nearestStop, pointAt, sameStop, stopName, stopsOn, trackAhead, trackFrom, tramAlong,
  tramOn, upTrack, ways,
} from './tramline';

/** the round's tram waits at the stop nearest the driver, this close (m) */
const STOP_R = 700;
/** the run: this many stops in this long (s); into the cab first, within this long (s) and a bit
 *  for the walk */
export const STOPS = 6;
const RUN_S = 360, CAB_S = 90;
/** a stop is served with the tram stopped and its nose this close to it (m), the doors open this
 *  long (s); one gone past by more than PASSED (m) is skipped */
export const AT_STOP = 6, DOORS_S = 3;
const PASSED = 8;
/** the "metro interval" to each stop: this long, and the way there at this speed (m/s), within
 *  these (s) */
const DUE_BASE = 22, DUE_SPEED = 9, DUE_MIN = 45, DUE_MAX = 80;
/** pay (€): a stop on time (and up to PRECISION more for stopping right at it), late; going past
 *  one costs SKIPPED */
const ON_TIME = 25, PRECISION = 15, LATE = 10, SKIPPED = 30;
/** bonuses: every stop on time, no damage */
const ALL_ON_TIME = 50, CLEAN = 20;
/** a car on the track this far ahead (m, before the next stop), after these stops */
const CAR_MIN = 140, CAR_MAX = 300, CAR_AFTER = [1, 3, 5];
const CAR_KINDS: VehicleKind[] = ['hatch', 'sedan', 'van', 'classic', 'hatch', 'sedan'];
/** the bell reaches a car's driver from this close (m); they're back and away in this long (s) */
export const BELL_R = 25, BELL_S = 8;
/** the tow truck, called, is there in this long (s); the second player's tows from this close (m) */
export const TOW_S = 20, TOW_R = 8;
/** pushing a car off the track: the damage (€); a tow by the second player earns the pair this */
export const DAMAGE = 150;
const TOW_BONUS = 15;
/** the track ahead is looked at this often (s), this far (m); a stop with no other this far past it
 *  (m) is at the end of the line; the view says which way to steer at a junction this close (m) */
const LOOK_EVERY = 0.25, LOOK_D = 2500, AFTER_MAX = 2000, JUNCTION_R = 220;
/** people this close to the middle of the track (m) are in the tram's way */
const CLEAR_W = 1.9;

interface Next {
  /** the stop (index into World.tramStops) */
  i: number;
  /** sim.time it's due, and when that was set */
  due: number;
  set: number;
  /** how far ahead along the track it was when last seen (m) */
  d: number;
}

interface Car {
  v: Vehicle;
  /** where it stood, and its health then (moved or hurt: the tram pushed it) */
  x: number;
  y: number;
  hp: number;
  /** parked on the track; its driver on the way (the bell); the tow truck on the way; driving off;
   *  pushed aside by the tram */
  state: 'parked' | 'bell' | 'tow' | 'away' | 'hit';
  /** sim.time it got to this state */
  t: number;
  /** its driver walking back to it */
  ped: Ped | null;
}

class Elektrickar extends MiniGame {
  private tram: Tram | null = null;
  /** the round put its tram in the city (it goes at the end) */
  private own = false;
  private phase: 'cab' | 'run' = 'cab';
  private next: Next | null = null;
  /** the stop last served or passed, so the next one isn't the other platform of it */
  private last = -1;
  /** the doors have been open this long at the stop (s) */
  private hold = 0;
  private done = 0;
  private onTime = 0;
  private tardy = 0;
  private skipped = 0;
  private hits = 0;
  /** what the run has earned so far (€) */
  private tally = 0;
  private cars: Car[] = [];
  /** a car is to be put on the track ahead (after a stop) */
  private carDue = false;
  private van: Vehicle | null = null;
  private bellWas = 0;
  private lookAcc = 0;
  /** the way to the next stop: the links after `on`, the one the tram was on when last looked at */
  private way: Link[] = [];
  private on: Link | null = null;
  /** the track ahead, as last looked at (along the way): its line and the stops on it */
  private ahead: ReturnType<typeof trackAhead> | null = null;
  /** how long the tram has stood with the throttle open (s): something's in front of it */
  private stuck = 0;
  /** said once: they got on as a passenger; they left the cab */
  private toldDoor = false;
  private toldOut = false;

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = CAB_S;
  }

  private get trams(): Trams {
    return this.sim.rule<Trams>('trams')!;
  }

  /** the one in the cab */
  private get driver(): SimPlayer | undefined {
    return this.players[0];
  }

  /** the second player: the tow truck */
  private get tow(): SimPlayer | undefined {
    return this.players[1];
  }

  // ------------------------------------------------------------------------------ the set-up
  start() {
    const d = this.driver!;
    if (!this.placeTram(d)) {
      for (const p of this.players) this.outcome(p, { pay: 0, text: 'Električka neprišla. Ako obvykle.' });
      return this.finish();
    }
    const t = this.tram!;
    this.round.left = CAB_S + dist(d.ped.x, d.ped.y, t.x, t.y) / 3;
    this.msg(d, 'DPB hľadá vodiča: nastúp do kabíny električky (F pri jej čele).', '#ffd740', 3.5);
    const q = this.tow;
    if (q) {
      this.van = this.placeVan(q);
      this.msg(q, 'Si odťahovka! Sadni do dodávky a čisti koľajnice pred električkou.', '#ffd740', 3.5);
    }
  }

  /** a tram at the stop nearest `p`, its doors open and waiting for its driver, at the nearest of its
   *  platforms (facing the way that platform's trams go) with a few stops on the track ahead: not one
   *  off to the end of the line, where the map ends and a tram only turns back */
  private placeTram(p: SimPlayer): boolean {
    const sim = this.sim, w = sim.world, S = w.tramStops;
    const f = p.focus();
    const i0 = nearestStop(w, f.x, f.y, STOP_R);
    if (i0 < 0) return false;
    const opts: { l: Link; s: number; n: number; d: number }[] = [];
    for (let j = 0; j < S.length; j += 2) {
      if (!sameStop(w, i0, j)) continue;
      for (const { l, s } of linksAt(w, j)) {
        if (leftHand(w, l)) continue;
        const n = trackFrom(w, l, s, 2000).stops.filter((q) => q.d > 10 && !sameStop(w, q.i, j)).length;
        opts.push({ l, s, n, d: dist(f.x, f.y, S[j], S[j + 1]) });
      }
    }
    // (any with a few stops ahead will do: the nearest of those)
    opts.sort((a, b) => Math.min(b.n, 3) - Math.min(a.n, 3) || a.d - b.d);
    for (const { l, s } of opts) {
      const put = upTrack(leadIn(w, l, 80), l, s, 0);
      if (!put) continue;
      const t = tramOn(w, sim.rng, put.link, put.then, put.at);
      if (!t) continue;
      t.follow([]);
      t.dwell = 1e9;
      // whatever of the city's stands in the way there goes
      sim.trams = sim.trams.filter((o) => carrying(sim, o) || !t.sections.some((sec) => o.hits(sec.x, sec.y, 1)));
      sim.addTram(t);
      this.tram = t;
      this.own = true;
      return true;
    }
    return false;
  }

  /** the tow truck: a van at the kerb near `p` */
  private placeVan(p: SimPlayer): Vehicle | null {
    const sim = this.sim, w = sim.world, f = p.focus();
    const n = w.car.nearest(f.x, f.y, 150);
    if (n < 0) return null;
    for (const l of w.car.out[n]) {
      const pts = linkPoints(l, l.edge.width / 2 - 1.2);
      for (const along of [10, 18, 26, 6]) {
        if (l.edge.len < along + 4) continue;
        const at = pointAt(pts, along);
        const v = new Vehicle('van', at.x, at.y, at.a, '#ffb300');
        if (w.spawnLevel(at.x, at.y, 1.2, at.a) !== 0 || !sim.clearFor(v)) continue;
        v.parked = true;
        return this.spawnVehicle(v);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------------------- each step
  update(dt: number) {
    const sim = this.sim;
    const d = this.driver;
    let t = this.tram;
    if (!d) return this.finish();
    const aboard = this.trams.of(d);
    // the driver took the cab of another tram: that's the run's tram now
    if (aboard?.cab && aboard.t !== t) {
      if (t && this.own) this.letGo(t);
      this.tram = t = aboard.t;
      this.own = false;
    }
    if (!t || !sim.trams.includes(t)) {
      // (the AI keeps trams only near someone: one waiting for a driver who walked off is gone)
      if (this.phase === 'cab' && this.placeTram(d)) return;
      return this.end('Električka zmizla z koľají.');
    }
    const inCab = !!aboard?.cab && aboard.t === t;
    if (aboard && !aboard.cab && !this.toldDoor) {
      this.toldDoor = true;
      this.msg(d, 'Si medzi cestujúcimi – vystúp (F) a choď do kabíny vpredu.', '#ffab40', 3.5);
    }
    if (this.phase === 'cab') {
      if (!inCab) return;
      this.phase = 'run';
      this.round.left = RUN_S;
      this.on = t.link;
      this.plan(t);
      this.look(t);
      if (this.next) this.tell(`Grafikon ako v metre – aspoň na papieri. Ďalšia zastávka: ${stopName(sim.world, this.next.i)}`, '#ffd740', 3.5);
      return;
    }
    // out of the cab mid-run: the tram waits where it stands (the AI would drive it off)
    if (!inCab) {
      if (t.speed < TRAM_STOPPED && t.dwell < 1e8) t.dwell = 1e9;
      if (!this.toldOut) {
        this.toldOut = true;
        this.msg(d, 'Vráť sa do kabíny (F pri čele električky)!', '#ffab40', 3);
      }
      for (const c of [...this.cars]) this.stepCar(c, t, dt);
      return;
    }
    this.toldOut = false;
    this.stuck = t.speed < 0.3 && t.ctl.throttle > 0.1 ? this.stuck + dt : 0;
    this.lookAcc += dt;
    if (this.lookAcc >= LOOK_EVERY) {
      this.lookAcc = 0;
      this.look(t);
      clearAhead(sim, t, this.ahead!.pts, this.stuck > 1.5, (o) => carrying(sim, o), true);
      this.checkPassed(t);
      if (this.carDue) this.placeCar(t);
    }
    this.serveStop(t, dt);
    if (t.speed > 0.5) this.clearTrack(t);
    for (const c of [...this.cars]) this.stepCar(c, t, dt);
    this.bellWas = t.bell;
    if (this.done >= STOPS) this.end();
  }

  /** People of the city's keep clear of the round's tram on the move: off the track in front of it,
   *  and a step back from its sides as it passes. A tram driven from the cab keeps to no one
   *  (Tram.drive), and the run is to its stops, not through the crowds at them. */
  private clearTrack(t: Tram) {
    const fx = Math.cos(t.angle), fy = Math.sin(t.angle), reach = 6 + t.speed * 1.5;
    for (const q of this.sim.pedsNear(t.x, t.y, reach + 30)) {
      if (q.playerId || q.kinematic || q.vehicle || q.aboard) continue;
      const dx = q.x - t.x, dy = q.y - t.y;
      const lon = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
      if (lon > -1 && lon < reach && Math.abs(lat) < CLEAR_W) {
        const to = (lat >= 0 ? 1 : -1) * (CLEAR_W + 0.5) - lat;
        q.x -= fy * to;
        q.y += fx * to;
        continue;
      }
      const s = t.hits(q.x, q.y, CLEAR_W - 1.2);
      if (!s) continue;
      const nx = -Math.sin(s.a), ny = Math.cos(s.a);
      const off = (q.x - s.x) * nx + (q.y - s.y) * ny;
      const to = (off >= 0 ? 1 : -1) * (CLEAR_W + 0.5) - off;
      q.x += nx * to;
      q.y += ny * to;
    }
  }

  /** Where the tram is on its way to the next stop: past a link of it, on along it; off it (another
   *  branch at a junction), the next stop is planned again from here. Then the track ahead, along
   *  the way while it's on it. */
  private look(t: Tram) {
    if (t.link !== this.on) {
      const k = this.way.indexOf(t.link);
      // (past the end of the way it went by the stop: checkPassed sees to that)
      const off = k < 0 && this.way.length > 0;
      if (k >= 0) this.way.splice(0, k + 1);
      this.on = t.link;
      if (off && this.next) this.plan(t);
    }
    this.ahead = trackAhead(this.sim.world, t, LOOK_D, 0, this.way);
  }

  /** The next stop of the run, and the way there: of the few nearest along the tracks (whichever
   *  way at the junctions ahead: the view says which way to steer), the one with another stop not
   *  too far past it — not one off at the end of the line, where the map ends and the tram only
   *  turns back. The same stop as before keeps its time. */
  private plan(t: Tram) {
    const sim = this.sim, w = sim.world;
    const all = new Ways(w, t.link, tramAlong(t), LOOK_D);
    const near = [...all.at.entries()]
      .filter(([i, r]) => r.len > 12 && !(this.last >= 0 && sameStop(w, i, this.last)))
      .sort((a, b) => a[1].cost - b[1].cost)
      .slice(0, 5);
    let best = -1, score = Infinity;
    for (const [i, r] of near) {
      const way = all.to(i)!;
      const l = way.length ? way[way.length - 1] : t.link;
      const at = stopsOn(w, l).find((o) => o.i === i)?.s ?? 0;
      let then = AFTER_MAX;
      for (const [j, q] of new Ways(w, l, at, AFTER_MAX).at) if (q.len > 12 && !sameStop(w, j, i) && !(this.last >= 0 && sameStop(w, j, this.last))) then = Math.min(then, q.len);
      const sc = r.cost + then * 0.7;
      if (sc < score) (score = sc), (best = i);
    }
    if (best < 0) {
      this.next = null;
      this.way = [];
      return;
    }
    this.way = all.to(best)!;
    this.on = t.link;
    const d = all.at.get(best)!.len;
    if (this.next?.i === best) {
      this.next.d = d;
      return;
    }
    const due = sim.time + clamp(DUE_BASE + d / DUE_SPEED, DUE_MIN, DUE_MAX);
    this.next = { i: best, due: Math.round(due), set: sim.time, d };
  }

  /** the junction ahead on the way where the driver has to steer (the straightest branch isn't the
   *  way): how far, and which way (-1 left, 1 right) */
  private junction(t: Tram): { d: number; dir: number } | null {
    const w = this.sim.world;
    let cur = t.link, acc = Math.max(0, t.link.edge.len - tramAlong(t));
    for (const l of this.way) {
      if (acc > JUNCTION_R) break;
      const opts = ways(w, cur);
      if (opts.length > 1 && branch(w, cur, 0) !== l) return { d: acc, dir: (opts.find((o) => o.l === l)?.d ?? 0) > 0 ? 1 : -1 };
      acc += l.edge.len;
      cur = l;
    }
    return null;
  }

  /** stopped at the stop: the doors open, and after a moment it's served */
  private serveStop(t: Tram, dt: number) {
    const sim = this.sim, w = sim.world, S = w.tramStops;
    if (!this.next) {
      this.plan(t);
      return;
    }
    const n = this.next;
    const d = dist(t.x, t.y, S[n.i], S[n.i + 1]);
    if (t.speed < TRAM_STOPPED && d <= AT_STOP) {
      // the doors open: the people at the stop get on and off (rules/Trams.ts, the crowd)
      if (this.hold === 0) this.tell('Dvere sa otvárajú…', '#b2ff59', 1.5);
      this.hold += dt;
      t.dwell = Math.max(t.dwell, 1);
      if (this.hold >= DOORS_S) this.served(t, d);
      return;
    }
    this.hold = 0;
    if (t.dwell > 0 && t.speed >= TRAM_STOPPED) t.dwell = 0;
  }

  private served(t: Tram, d: number) {
    const sim = this.sim, w = sim.world, n = this.next!;
    const name = stopName(w, n.i);
    const late = sim.time - n.due;
    let earn: number;
    if (late <= 0) {
      earn = Math.round(ON_TIME + PRECISION * clamp((AT_STOP - d) / (AT_STOP - 1), 0, 1));
      this.onTime++;
      this.tell(`${name} – načas! +€${earn}`, '#69f0ae', 2.5);
    } else {
      earn = LATE;
      this.tardy++;
      this.tell(`${name} – meškáš ${Math.ceil(late)} s. Cestujúci si zvykli. +€${earn}`, '#ffd740', 2.5);
    }
    this.tally += earn;
    for (const p of this.players) this.pop(p, `+€${earn}`, t.x, t.y - 3);
    t.dwell = 0;
    this.hold = 0;
    this.stopDone(t, n.i);
  }

  /** the next stop's no longer ahead on the way: gone past without stopping (skipped), or it isn't
   *  where the tram's going any more (planned again) */
  private checkPassed(t: Tram) {
    const n = this.next;
    if (!n || this.hold > 0) return;
    const w = this.sim.world, S = w.tramStops;
    const s = this.ahead!.stops.find((q) => q.i === n.i);
    if (s) {
      n.d = s.d;
      return;
    }
    if (n.d < PASSED + 12) {
      // just by it: it may yet stop within reach of it
      if (dist(t.x, t.y, S[n.i], S[n.i + 1]) <= PASSED) return;
      this.skipped++;
      this.tally -= SKIPPED;
      this.tell(`Zastávku ${stopName(w, n.i)} si prešiel! Cestujúci búchajú na dvere. −€${SKIPPED}`, '#ff5252', 3);
      return this.stopDone(t, n.i);
    }
    this.plan(t);
  }

  /** a stop done (served or skipped): on to the next, and after some a car on the track ahead */
  private stopDone(t: Tram, i: number) {
    this.last = i;
    this.done++;
    if (CAR_AFTER.includes(this.done) && this.done < STOPS) this.carDue = true;
    this.next = null;
    if (this.done < STOPS) this.plan(t);
    this.look(t);
  }

  // ------------------------------------------------------------------------ cars on the track
  /** a car parked on the track 140–300 m ahead, where nobody sees it put, clear of the stops */
  private placeCar(t: Tram) {
    const sim = this.sim, w = sim.world, rng = sim.rng, a = this.ahead!;
    // (before the next stop: past it, the way on isn't known yet; a short way there, the next time)
    const max = Math.min(CAR_MAX, (this.next?.d ?? 0) - 30);
    if (max < CAR_MIN) return;
    const span = Math.floor((max - CAR_MIN) / 10);
    const off = rng.int(span + 1);
    for (let k = 0; k <= span; k++) {
      const d = CAR_MIN + ((k + off) % (span + 1)) * 10;
      if (a.stops.some((s) => Math.abs(s.d - d) < 30)) continue;
      const p = pointAt(a.pts, d);
      const kind = rng.pick(CAR_KINDS);
      const ang = p.a + rng.range(-0.3, 0.3);
      const side = rng.range(-0.5, 0.5);
      const x = p.x - Math.sin(p.a) * side, y = p.y + Math.cos(p.a) * side;
      if (sim.visibleToAny(x, y, 8) || w.spawnLevel(x, y, 1.2, ang) !== t.level || w.inWater(x, y, t.level)) continue;
      const v = new Vehicle(kind, x, y, ang, rng.pick(SPECS[kind].colors));
      v.level = t.level;
      if (!sim.clearFor(v)) continue;
      v.parked = true;
      this.spawnVehicle(v);
      this.cars.push({ v, x, y, hp: v.health, state: 'parked', t: sim.time, ped: null });
      this.carDue = false;
      this.msg(this.driver!, 'Auto na koľajniciach! Zvoň (H), odťahovka (B), alebo ho odtlač – škoda 150 €.', '#ffab40', 4);
      if (this.tow) this.msg(this.tow, 'Auto na koľajniciach pred električkou – odtiahni ho (B pri ňom)!', '#ffab40', 3.5);
      return;
    }
  }

  private stepCar(c: Car, t: Tram, dt: number) {
    const sim = this.sim, w = sim.world, now = sim.time, v = c.v;
    if (!sim.vehicles.includes(v)) return this.dropCar(c);
    const blocking = c.state === 'parked' || c.state === 'bell' || c.state === 'tow';
    // pushed off the track by the tram: the damage
    if (blocking && (dist(v.x, v.y, c.x, c.y) > 1.2 || v.health < c.hp - 3)) {
      if (t.hits(c.x, c.y, 2.5) || dist(t.x, t.y, v.x, v.y) < 8) {
        c.state = 'hit';
        c.t = now;
        this.hits++;
        this.tally -= DAMAGE;
        this.tell(`Bum! Škoda na aute ${DAMAGE} €.`, '#ff5252', 3);
        for (const p of this.players) this.pop(p, `-€${DAMAGE}`, v.x, v.y - 1.5);
        if (c.ped) this.despawn(c.ped), (c.ped = null);
      } else if (dist(v.x, v.y, c.x, c.y) > 3) {
        // (someone else moved it: it's off the track, that's all)
        c.state = 'away';
        c.t = now;
      }
      return;
    }
    switch (c.state) {
      case 'parked':
        // the bell (H) rung near it: its driver comes running
        if (t.bell > this.bellWas + 0.5 && dist(t.x, t.y, v.x, v.y) <= BELL_R) {
          c.state = 'bell';
          c.t = now;
          c.ped = this.driverFor(v);
          this.tell('Crnk-crnk! Vodič beží k autu…', '#b2ff59', 2.5);
        }
        break;
      case 'bell': {
        // (their driver walks back to it, unless something's knocked them off their feet: then they
        // get up and go home to change, as anyone in the city does, and the car's towed instead)
        const p = c.ped;
        if (p?.dazed) {
          this.release(p);
          c.ped = null;
          c.state = 'tow';
          c.t = now;
          this.tell(`Vodič sedí na zemi. Odťahovka je na ceste (${TOW_S} s).`, '#ffd740', 2.5);
          break;
        }
        if (p && (p.state === 'walk' || p.state === 'idle')) {
          const dd = dist(p.x, p.y, v.x, v.y);
          const sp = Math.min(3, dd / Math.max(dt, 1e-3));
          if (dd > 1.6) {
            p.move(dt, w, ((v.x - p.x) / dd) * sp, ((v.y - p.y) / dd) * sp);
            p.state = 'walk';
          } else p.state = 'idle';
        }
        if (now - c.t >= BELL_S) this.driveOff(c, 'Vodič odparkoval. Môžeš ísť!');
        break;
      }
      case 'tow':
        if (now - c.t >= TOW_S) {
          this.tell('Odťahovka odviezla auto. Koľaj je voľná.', '#69f0ae', 2.5);
          this.dropCar(c);
        }
        break;
      case 'away':
      case 'hit':
        // gone once it's out of sight (or after a while anyway)
        if ((now - c.t > 3 && !sim.visibleToAny(v.x, v.y, 6)) || now - c.t > 15) this.dropCar(c);
        break;
    }
  }

  /** the car's driver, from a doorway nearby, off the track */
  private driverFor(v: Vehicle): Ped {
    const sim = this.sim, w = sim.world;
    const nx = -Math.sin(v.angle), ny = Math.cos(v.angle);
    const at = { x: v.x + nx * 10, y: v.y + ny * 10 };
    for (const side of [1, -1])
      for (const r of [14, 10, 18]) {
        const q = w.walkableNear(v.x + nx * r * side, v.y + ny * r * side);
        const dd = dist(q.x, q.y, v.x, v.y);
        if (dd > 5 && dd < 26) return this.spawnDriver(q.x, q.y, v);
      }
    return this.spawnDriver(at.x, at.y, v);
  }

  private spawnDriver(x: number, y: number, v: Vehicle): Ped {
    const p = new Ped('civ', x, y, this.sim.rng.seed());
    p.level = v.level;
    p.levelInit = true;
    p.state = 'walk';
    return this.spawnPed(p);
  }

  /** the driver's in: the car drives off along the streets (or, where there's no way, it's just gone) */
  private driveOff(c: Car, text: string) {
    const sim = this.sim, w = sim.world, v = c.v;
    if (c.ped) this.despawn(c.ped);
    c.ped = null;
    this.tell(text, '#69f0ae', 2.5);
    const from = w.car.nearest(v.x, v.y, 60);
    const far = from >= 0 ? w.car.nodesAround(v.x, v.y, 150, 320) : [];
    const route = far.length ? w.car.path(from, sim.rng.pick(far)) : null;
    if (!route?.length) return this.dropCar(c);
    v.parked = false;
    sim.ai.driveRoute(v, route);
    c.state = 'away';
    c.t = sim.time;
  }

  private dropCar(c: Car) {
    if (c.ped) this.despawn(c.ped);
    this.despawn(c.v);
    this.cars.splice(this.cars.indexOf(c), 1);
  }

  /** the cars still in the tram's way, nearest first */
  private blocking(): Car[] {
    const t = this.tram;
    if (!t) return [];
    return this.cars.filter((c) => c.state === 'parked' || c.state === 'bell' || c.state === 'tow').sort((a, b) => dist(a.v.x, a.v.y, t.x, t.y) - dist(b.v.x, b.v.y, t.x, t.y));
  }

  // ------------------------------------------------------------------------ the action key
  act(p: SimPlayer) {
    const sim = this.sim, now = sim.time;
    if (p === this.tow) {
      const c = this.towable(p);
      if (!c) return;
      this.tally += TOW_BONUS;
      this.tell(`Odtiahnuté! Koľaj je voľná. +€${TOW_BONUS}`, '#69f0ae', 2.5);
      this.dropCar(c);
      return;
    }
    const c = this.phase === 'run' ? this.blocking().find((q) => q.state === 'parked') : undefined;
    if (!c) return;
    c.state = 'tow';
    c.t = now;
    this.tell(`Odťahovka je na ceste (${TOW_S} s).`, '#ffd740', 2.5);
  }

  /** a car on the track the second player can tow right now: in a vehicle, next to it */
  private towable(p: SimPlayer): Car | undefined {
    const v = p.ped.vehicle;
    if (!v) return undefined;
    return this.blocking().find((c) => dist(c.v.x, c.v.y, v.x, v.y) <= TOW_R + v.spec.length / 2);
  }

  /** taking the cab isn't stealing the tram: the round's driver works for DPB */
  allowCrime(p: SimPlayer, kind: Crime) {
    return !(kind === 'stealTram' && this.has(p));
  }

  // ------------------------------------------------------------------------------ the end
  onTimeout() {
    this.end();
  }

  onLeave(p: SimPlayer) {
    // without its driver there's no run; the tow truck alone can't carry on
    if (p === this.driver) this.end('Vodič odišiel zo smeny.', p);
  }

  /** the shift's over: both are paid what the run earned, with the bonuses */
  private end(why = '', gone?: SimPlayer) {
    if (this.over) return;
    let pay = 0, text: string;
    if (this.phase === 'cab') text = why || 'Do kabíny si nenastúpil – električka odišla bez vodiča.';
    else {
      const bonus = (this.done && this.onTime === this.done && this.done >= STOPS ? ALL_ON_TIME : 0) + (this.done && !this.hits ? CLEAN : 0);
      pay = Math.max(0, this.tally + bonus);
      const bits = [`${this.onTime}/${STOPS} zastávok načas`];
      if (this.tardy) bits.push(`${this.tardy}× meškanie`);
      if (this.skipped) bits.push(`${this.skipped}× prejdená`);
      if (this.hits) bits.push(`škoda ${this.hits * DAMAGE} €`);
      text = `${why ? why + ' ' : ''}Koniec smeny: ${bits.join(', ')}.`;
    }
    for (const p of this.players) if (p !== gone) this.outcome(p, { pay, text });
    this.finish();
  }

  /** a tram of the round's no longer needed: it goes back to the AI, a city tram like any other */
  private letGo(t: Tram) {
    t.dwell = 0;
    t.follow([]);
  }

  dispose() {
    const t = this.tram;
    if (t && this.own) this.sim.trams = this.sim.trams.filter((o) => o !== t);
    else if (t && t.dwell > 1e8) t.dwell = 0;
    super.dispose();
  }

  // -------------------------------------------------------------------------------- the view
  view(p: SimPlayer): MiniView {
    return p === this.tow ? this.towView(p) : this.driverView(p);
  }

  private carMarks(arrow: boolean): MiniMark[] {
    const labels = { parked: 'auto na koľajniciach', bell: 'vodič beží', tow: 'čaká na odťahovku', away: 'odchádza', hit: 'škoda' };
    const first = this.blocking()[0];
    return this.cars.map((c) => ({
      x: Math.round(c.v.x), y: Math.round(c.v.y), e: c.v.id, icon: c.state === 'hit' ? '💥' : '🚗', label: labels[c.state], color: '#ff9800', r: 3,
      arrow: arrow && c === first ? 1 : undefined, dim: c.state === 'away' || c.state === 'hit' ? 1 : undefined,
    }));
  }

  private driverView(p: SimPlayer): MiniView {
    const sim = this.sim, w = sim.world, S = w.tramStops, t = this.tram;
    const marks: MiniMark[] = [];
    if (!t) return { goal: 'Električkár' };
    const cab = { x: Math.round(t.x + Math.cos(t.angle) * 0.8), y: Math.round(t.y + Math.sin(t.angle) * 0.8) };
    const inCab = !!this.trams.of(p)?.cab;
    if (this.phase === 'cab' || !inCab) {
      marks.push({ ...cab, icon: '🚋', label: 'kabína – F', color: '#e53935', r: 2.5, arrow: 1 });
      return {
        goal: this.phase === 'cab' ? 'Nastúp do kabíny električky – F pri jej čele.' : 'Vráť sa do kabíny (F pri čele električky)!',
        stats: [['Smena', `${STOPS} zastávok`]],
        marks: [...marks, ...this.carMarks(false)],
      };
    }
    const n = this.next;
    if (n) {
      marks.push({ x: Math.round(S[n.i]), y: Math.round(S[n.i + 1]), icon: '🚏', label: stopName(w, n.i), color: '#e53935', r: AT_STOP, arrow: 1 });
      // the ones after it, faded
      let k = 0;
      for (const s of this.ahead?.stops ?? []) {
        if (s.d <= n.d + 10 || sameStop(w, s.i, n.i) || k >= 2) continue;
        marks.push({ x: Math.round(S[s.i]), y: Math.round(S[s.i + 1]), icon: '🚏', label: stopName(w, s.i), color: '#ef9a9a', r: 3, dim: 1, noMap: 1 });
        k++;
      }
    }
    if (this.van) marks.push({ x: Math.round(this.van.x), y: Math.round(this.van.y), e: this.van.id, icon: '🛻', label: 'odťahovka', color: '#ffb300', noMap: 1 });
    marks.push(...this.carMarks(false));
    const car = this.blocking()[0];
    const carNear = car && dist(car.v.x, car.v.y, t.x, t.y) < 250;
    const left = n ? n.due - sim.time : 0;
    const fork = n ? this.junction(t) : null;
    const goal =
      this.hold > 0
        ? 'Dvere sa otvárajú…'
        : carNear && car.state === 'bell'
          ? 'Vodič beží k autu… počkaj.'
          : carNear && car.state === 'tow'
            ? 'Odťahovka je na ceste – počkaj, alebo odtlač auto (škoda 150 €).'
            : carNear
              ? 'Auto na koľajniciach! Zvoň (H), odťahovka (B), alebo ho odtlač – škoda 150 €.'
              : !n
                ? 'Jazdi ďalej – zastávka príde.'
                : n.d < 70
                  ? `Brzdi! Zastav pri zastávke ${stopName(w, n.i)}`
                  : fork
                    ? `Výhybka o ${Math.max(10, Math.round(fork.d / 10) * 10)} m: drž ${fork.dir < 0 ? 'doľava ←' : 'doprava →'}, smer ${stopName(w, n.i)}`
                    : `Ďalšia zastávka: ${stopName(w, n.i)} (${Math.round(n.d / 10) * 10} m)`;
    const stats: [string, string][] = [
      ['Zastávka', `${Math.min(STOPS, this.done + 1)}/${STOPS}`],
      [left >= 0 ? 'Grafikon' : 'Meškáš', left >= 0 ? `${Math.ceil(left)} s` : `${Math.ceil(-left)} s`],
      ['Zárobok', `€${Math.max(0, Math.round(this.tally))}`],
    ];
    const span = n ? Math.max(1, n.due - n.set) : 1;
    const bar = this.hold > 0
      ? { label: 'Dvere', v: this.hold / DOORS_S, color: '#69f0ae' }
      : n
        ? { label: 'Interval', v: clamp(left / span, 0, 1), color: left < 0 ? '#ff5252' : left / span < 0.3 ? '#ffb300' : '#4fc3f7' }
        : undefined;
    return { goal, stats, bar, marks, act: carNear && car.state === 'parked' ? `Zavolať odťahovku (${TOW_S} s)` : undefined };
  }

  private towView(p: SimPlayer): MiniView {
    const t = this.tram;
    const marks: MiniMark[] = [];
    const blocking = this.blocking();
    marks.push(...this.carMarks(true));
    if (t) marks.push({ x: Math.round(t.x), y: Math.round(t.y), icon: '🚋', label: 'električka', color: '#e53935', r: 3 });
    const inVan = !!p.ped.vehicle;
    if (this.van && p.ped.vehicle !== this.van) marks.push({ x: Math.round(this.van.x), y: Math.round(this.van.y), e: this.van.id, icon: '🛻', label: 'tvoja odťahovka', color: '#ffb300', r: 2.5, arrow: blocking.length ? undefined : 1 });
    const goal = !inVan
      ? 'Sadni do odťahovky (F) a jazdi pred električkou.'
      : blocking.length
        ? 'Auto na koľajniciach! Zastav pri ňom a odtiahni ho (B).'
        : 'Jazdi pred električkou a strež koľajnice.';
    return {
      goal,
      stats: [['Zastávky', `${this.done}/${STOPS}`], ['Zárobok', `€${Math.max(0, Math.round(this.tally))}`]],
      marks,
      act: this.towable(p) ? 'Odtiahnuť auto' : undefined,
    };
  }

  lobbyView(): MiniView {
    return { goal: 'Nová smena v DPB. Metro sme nedostali, tak aspoň električku.' };
  }
}

export const TRAM_DEF: MiniGameDef = {
  kind: 'tram',
  lobby: 20,
  create(sim, round) {
    if (nearestStop(sim.world, round.x, round.y, STOP_R) < 0) return 'Tu električky nechodia – choď bližšie k trati (Kamenné, Šafárikovo, Most SNP…).';
    return new Elektrickar(sim, round);
  },
};
