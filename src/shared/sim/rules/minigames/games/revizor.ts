// Revízor (docs/plans/minigames.md): Bratislava's ticket inspectors. Everyone in the city has a story
// about the DPB's "revízori", since 2026 they wear body cams, and a fine on the spot is about €70–80.
//
// Alone, the player is a fare dodger (a "čierny pasažier"): a stop 1–2 km away along the tracks is
// the target, and they have to ride there (walking doesn't count). Inspectors (people in dark
// jackets, 🎫) wait at some of the stops on the way. One boards the tram the player's on when it
// stops at theirs, and a few seconds later checks them — €79 and it's over — unless they've got off
// first; one who sees them get off goes after them on foot for a while. Half the rounds have a
// "výluka": the target moves mid-way. With others, the players split into dodgers and inspectors:
// an inspector catches a dodger by riding the same tram with them for a few seconds, or on foot
// right after they got off one; dodgers score by the stops they ride and the targets they reach.
//
// The trams are the city's own (rules/Trams.ts: on at an open door of a tram at a stop, off once it's
// stopped). The AI only has a few of them about, going wherever, so the round runs its own: one comes
// in, out of sight, to a stop where a player waits and keeps to the way to their target (tramline.ts),
// and any other tram a dodger boards is turned onto that way too. They go when the round ends.
import { dist } from '../../../../util/math';
import { Ped } from '../../../../entities/Ped';
import type { Tram } from '../../../../entities/Tram';
import type { Link } from '../../../../world/Graph';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import type { Trams } from '../../Trams';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';
import {
  Ways, carrying, clearAhead, doorNear, leadIn, leftHand, lineChanges, linksAt, nearestStop, platform, sameStop, stopAt, stopName, stopsOn,
  trackAhead, tramAlong, tramOn, upTrack,
} from './tramline';

/** the round starts from the stop nearest its starter, this close (m) */
const START_R = 600;
/** the target: this far along the track (m); the way there no dearer per metre than this (the
 *  left-hand track costs more: tramline.ts) and with at most one change of line */
const TARGET_MIN = 1000, TARGET_MAX = 2000, TARGET_COST = 1.25;
/** with others, a dodger's next target once they've reached one (m along the track) */
const NEXT_MIN = 700, NEXT_MAX = 1600;
/** the výluka moves the target this much further on (m) */
const MOVE_MIN = 300, MOVE_MAX = 900;
/** stops ridden (since the start, or the last target) before getting off at the target counts */
const MIN_RIDE = 3;
/** inspectors waiting at stops on the way, alone */
const NPC_MAX = 3;
/** aboard together this long (s), an inspector has checked them: one of the city's, a player */
const CHECK_NPC = 6, CHECK_PLAYER = 5;
/** the fine on the spot (€) */
export const FINE = 79;
/** this close (m) on foot, caught */
const REACH = 1.5;
/** an inspector who saw someone get off (from this close, m) goes after them this long (s), running
 *  at RUN (m/s: faster than a walk, 4.6, slower than a sprint, 7.2) */
const SEE_OFF = 25, CHASE_S = 12, RUN = 5.5;
/** an inspector hurries to a tram's door at this, and walks back to the platform at this (m/s);
 *  knocked off their feet, they're up again in this long (s) */
const HURRY = 2.8, WALK = 1.6, DOWN_S = 6;
/** with others, an inspector catches on foot a dodger who got off a tram this recently (s) */
const OFF_RECENT = 15;
/** caught with others, a dodger can't be again for this long (s) */
const IMMUNE_S = 20;
/** a player this close to a stop (m) waits there: one of the round's trams comes */
const WAIT_R = 25;
/** the round's own trams come in from this far up the track (m), the first of these nobody sees,
 *  and not again to the same platform for this long (s) */
const LEAD_AT = [220, 260, 180, 300, 150, 330], RESEND_S = 8;
/** at most this many of the round's own trams at once: alone, with others */
const OWN_SOLO = 2, OWN_GROUP = 4;
/** a round tram held up this long (s) has what's in front of it cleared: a tram of the city's
 *  coming the other way, a car parked on the track, someone standing on it */
const STUCK_S = 3;
/** the trams are looked after this often (s) */
const SERVE_EVERY = 0.5;
/** time limits (s): alone by the way's length, with others fixed */
const SOLO_MIN = 300, SOLO_MAX = 540, GROUP_S = 240;
/** pay alone: made it, by the stops ridden; out of time, a little a stop */
const PAY_BASE = 110, PAY_STOP = 20, PAY_MIN = 150, PAY_MAX = 250, PAY_LATE_STOP = 8;
/** points (and € with others): a stop ridden, a target reached, a catch (the inspector keeps the
 *  fine), and what a catch costs the dodger */
const PTS_STOP = 10, PTS_TARGET = 60, PTS_CATCH = 80, PTS_CAUGHT = 20;

type Role = 'dodger' | 'inspector';

/** "1 zastávka", "3 zastávky", "5 zastávok" */
const stops = (n: number) => `${n} ${n === 1 ? 'zastávka' : n >= 2 && n <= 4 ? 'zastávky' : 'zastávok'}`;

interface Rider {
  p: SimPlayer;
  role: Role;
  /** a dodger's target stop (index into World.tramStops) */
  target: number;
  /** the tram they were on at the last step */
  on: Tram | null;
  /** the stop that tram last stood at with them aboard (a new one is a stop ridden) */
  lastAt: number;
  ridden: number;
  /** ridden since the start or the last target reached */
  leg: number;
  targets: number;
  /** sim.time they last got off a tram */
  offAt: number;
  caught: number;
  /** can't be caught again before this sim.time; caught aboard, they're seen off at the next stop */
  immune: number;
  escort: boolean;
  /** an inspector's catches, and the time aboard with each dodger (by id) */
  catches: number;
  checks: Map<number, number>;
  /** waiting at a stop: the platform (a stop's entry) to board at for their target, the link through
   *  it and how far along; `hint`: the same, for the stop the view points them to */
  board: { i: number; l: Link; s: number; from: number; at: number } | null;
  hint: Rider['board'];
  done: boolean;
}

interface Npc {
  ped: Ped;
  /** the stop they wait at, and the spot on its platform */
  home: number;
  spot: { x: number; y: number; a: number };
  state: 'wait' | 'board' | 'aboard' | 'chase' | 'back';
  tram: Tram | null;
  /** aboard: how long they've been checking whoever's there (s) */
  check: number;
  chase: Rider | null;
  until: number;
  /** knocked off their feet this long (s) */
  down: number;
}

/** a tram running for the round: its own, or one of the city's turned onto the way */
interface Run {
  t: Tram;
  own: boolean;
  /** the stop it runs to */
  to: number;
  /** the link it was on when given its way, and the way (the links after that one) */
  on: Link;
  way: Link[];
  /** how long it has stood blocked (s) */
  stuck: number;
}

class Revizor extends MiniGame {
  private riders = new Map<number, Rider>();
  private npcs: Npc[] = [];
  private runs: Run[] = [];
  /** where the round starts (a platform) and its target, as picked when it opens; the stops on the
   *  way between where the city's inspectors wait */
  private start0 = -1;
  private target0 = -1;
  private npcStops: number[] = [];
  /** the výluka: this round has one (alone, half of them), it's happened, the stop it closed */
  private vyluka = false;
  private vylukaDone = false;
  private closed = -1;
  /** it started with others: dodgers against players as inspectors */
  private group = false;
  private serveAcc = 0;
  /** when a tram of the round's was last sent to each platform */
  private sent = new Map<number, number>();

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = SOLO_MAX;
  }

  private get trams(): Trams {
    return this.sim.rule<Trams>('trams')!;
  }

  // ------------------------------------------------------------------------------ the set-up
  /** The start (the stop nearest (x, y)) and a target 1–2 km along the track from it, with the stops
   *  for the inspectors on the way. Why not, or null. */
  pick(x: number, y: number): string | null {
    const w = this.sim.world, rng = this.sim.rng;
    const i0 = nearestStop(w, x, y, START_R);
    if (i0 < 0) return 'Tu električky nechodia – choď bližšie k trati (Kamenné, Šafárikovo, Most SNP…).';
    type Cand = { j: number; l: Link; s: number; i: number; len: number; way: Link[] };
    const find = (min: number, max: number, cost: number, changes: number) => {
      const out: Cand[] = [];
      for (let j = 0; j < w.tramStops.length; j += 2) {
        if (!sameStop(w, i0, j)) continue;
        for (const { l, s } of linksAt(w, j)) {
          if (leftHand(w, l)) continue;
          const ways = new Ways(w, l, s, max + 100);
          for (const [i, r] of ways.at) {
            if (sameStop(w, i0, i) || r.len < min || r.len > max || r.cost > r.len * cost) continue;
            const way = ways.to(i)!;
            if (lineChanges([l, ...way]) > changes || out.some((c) => sameStop(w, c.i, i))) continue;
            out.push({ j, l, s, i, len: r.len, way });
          }
        }
      }
      return out;
    };
    let cands = find(TARGET_MIN, TARGET_MAX, TARGET_COST, 1);
    if (!cands.length) cands = find(TARGET_MIN * 0.7, TARGET_MAX * 1.3, 1.6, 9);
    if (!cands.length) return 'Odtiaľto sa električkou ďaleko nedostaneš – skús inú zastávku.';
    const c = rng.pick(cands);
    this.start0 = c.j;
    this.target0 = c.i;
    // the stops on the way between (on this track), for the inspectors
    const between: number[] = [];
    way: for (const [k, l] of [c.l, ...c.way].entries())
      for (const o of stopsOn(w, l)) {
        if (k === 0 && o.s <= c.s + 1) continue;
        if (sameStop(w, c.i, o.i)) break way;
        if (!sameStop(w, c.j, o.i) && !between.includes(o.i)) between.push(o.i);
      }
    const n = Math.min(NPC_MAX, between.length ? Math.max(1, Math.round(between.length * 0.55)) : 0);
    const off = rng.next();
    for (let k = 0; k < n; k++) this.npcStops.push(between[Math.min(between.length - 1, Math.floor(((k + off) * between.length) / n))]);
    this.npcStops = [...new Set(this.npcStops)];
    // alone: time for the walk to the stop, the first tram, the ride and a change of plan or two
    const walk = dist(x, y, w.tramStops[c.j], w.tramStops[c.j + 1]) / 3;
    const est = walk + 35 + c.len / 7 + (between.length + 1) * 15;
    this.duration = Math.round(Math.max(SOLO_MIN, Math.min(SOLO_MAX, est * 1.6 + 60)));
    return null;
  }

  start() {
    const sim = this.sim;
    const group = (this.group = this.players.length >= 2);
    // with others: one inspector for every two or three, by the order they joined (never the starter)
    let inspectors = 0;
    this.players.forEach((p, k) => {
      const want = Math.ceil((k + 1) / 3);
      const role: Role = group && k > 0 && inspectors < want ? 'inspector' : 'dodger';
      if (role === 'inspector') inspectors++;
      this.riders.set(p.id, this.newRider(p, role));
    });
    if (group) {
      this.duration = GROUP_S;
      this.round.left = GROUP_S;
      for (const r of this.riders.values())
        this.msg(r.p, r.role === 'inspector' ? 'Si revízor! Chyť čiernych pasažierov – pokuta ide tebe.' : 'Si čierny pasažier! Vez sa do cieľa bez lístka.', '#ffd740', 3.5);
    } else {
      this.round.left = this.duration;
      this.vyluka = sim.rng.chance(0.5);
      for (const i of this.npcStops) this.addInspector(i);
      this.tell(`Bez lístka až na zastávku ${stopName(sim.world, this.target0)} – pozor na revízorov!`, '#ffd740', 3.5);
    }
  }

  private newRider(p: SimPlayer, role: Role): Rider {
    return {
      p, role, target: this.target0, on: null, lastAt: -1, ridden: 0, leg: 0, targets: 0, offAt: -1e9, caught: 0, immune: 0, escort: false,
      catches: 0, checks: new Map(), board: null, hint: null, done: false,
    };
  }

  /** an inspector of the city's waiting at stop `i`: a person in a dark jacket (a 'suit': the look
   *  comes from the seed on every client) */
  private addInspector(i: number) {
    const sim = this.sim;
    let seed = sim.rng.seed();
    for (let k = 0; k < 60 && new Ped('civ', 0, 0, seed).archetype !== 'suit'; k++) seed = sim.rng.seed();
    const spot = platform(sim.world, i, sim.rng.range(-5, 5));
    const ped = new Ped('civ', spot.x, spot.y, seed);
    ped.angle = spot.a;
    ped.state = 'idle';
    ped.level = sim.world.spawnLevel(spot.x, spot.y, ped.r);
    ped.levelInit = true;
    this.spawnPed(ped);
    this.npcs.push({ ped, home: i, spot, state: 'wait', tram: null, check: 0, chase: null, until: 0, down: 0 });
  }

  // ------------------------------------------------------------------------------- each step
  update(dt: number) {
    for (const r of this.riders.values()) this.track(r);
    if (this.over) return;
    for (const n of this.npcs) this.stepNpc(n, dt);
    if (this.over) return;
    this.inspect(dt);
    this.serveAcc += dt;
    if (this.serveAcc >= SERVE_EVERY) {
      this.serve(this.serveAcc);
      this.serveAcc = 0;
    }
    this.twist();
    // with others, a round with no dodger left in it is over
    if (this.group && ![...this.riders.values()].some((r) => r.role === 'dodger')) this.settle();
  }

  /** a rider's tram: getting on, the stops it stands at with them aboard, getting off */
  private track(r: Rider) {
    const w = this.sim.world;
    const on = r.p.state === 'play' ? (this.trams.of(r.p)?.t ?? null) : null;
    if (r.escort && (!on || (on.speed < 0.5 && this.trams.act(r.p, 'off')))) {
      // caught aboard: off at the first standstill, the inspector at their elbow
      if (on) this.msg(r.p, 'Revízor ťa vyviedol z električky.', '#ffab40');
      r.escort = false;
      r.on = null;
      r.offAt = this.sim.time;
      return;
    }
    if (on !== r.on) {
      const was = r.on;
      r.on = on;
      if (on) this.boarded(r, on);
      if (was && !on) this.alighted(r, was);
    }
    if (!on) return;
    const at = on.dwell > 0.3 || (on.driver && on.speed < 0.2) ? stopAt(w, on.x, on.y) : -1;
    if (at >= 0 && at !== r.lastAt) {
      r.lastAt = at;
      r.ridden++;
      r.leg++;
      if (this.group && r.role === 'dodger') this.addPoints(r.p, PTS_STOP);
      this.pop(r.p, `${r.ridden}. zastávka zadarmo`, on.x, on.y - 3);
    }
  }

  private boarded(r: Rider, t: Tram) {
    r.lastAt = stopAt(this.sim.world, t.x, t.y);
    if (r.role === 'dodger' && !r.done && !this.runs.some((q) => q.t === t)) this.adopt(t, r.target);
  }

  private alighted(r: Rider, t: Tram) {
    const w = this.sim.world, S = w.tramStops;
    r.offAt = this.sim.time;
    if (r.role !== 'dodger' || r.done) return;
    const here = (i: number) => {
      for (let j = 0; j < S.length; j += 2) if (sameStop(w, i, j) && (dist(S[j], S[j + 1], t.x, t.y) < 12 || dist(S[j], S[j + 1], r.p.ped.x, r.p.ped.y) < 30)) return true;
      return false;
    };
    if (here(r.target)) {
      if (r.leg >= MIN_RIDE) return this.reached(r);
      this.msg(r.p, `Pešo sa to neráta – aspoň ${MIN_RIDE} zastávky sa musíš zviezť (máš ${r.leg}).`, '#ff8a80', 3.5);
    } else if (this.closed >= 0 && here(this.closed)) this.msg(r.p, 'Tu je výluka – cieľ sa presunul!', '#ffab40');
  }

  /** a dodger got off at their target */
  private reached(r: Rider) {
    const w = this.sim.world;
    if (!this.group) {
      r.done = true;
      const pay = Math.max(PAY_MIN, Math.min(PAY_MAX, PAY_BASE + PAY_STOP * r.ridden));
      this.outcome(r.p, { pay, text: `Si v cieli bez lístka! ${stops(r.ridden)} zadarmo.` });
      this.pop(r.p, 'V CIELI!', r.p.ped.x, r.p.ped.y - 1.7);
      this.finish();
      return;
    }
    r.targets++;
    r.leg = 0;
    this.addPoints(r.p, PTS_TARGET);
    const next = this.nextTarget(r.target, NEXT_MIN, NEXT_MAX);
    if (next >= 0) r.target = next;
    r.board = r.hint = null;
    this.msg(r.p, `V cieli! +${PTS_TARGET} bodov. Ďalší cieľ: ${stopName(w, r.target)}`, '#69f0ae', 3.5);
    for (const q of this.riders.values()) if (q !== r) this.msg(q.p, `${r.p.nick} je v cieli!`, '#ffd740');
  }

  /** a stop `min`–`max` metres on along the track from stop `from` (the right-hand way), or -1 */
  private nextTarget(from: number, min: number, max: number): number {
    const w = this.sim.world;
    const out: number[] = [];
    for (let j = 0; j < w.tramStops.length; j += 2) {
      if (!sameStop(w, from, j)) continue;
      for (const { l, s } of linksAt(w, j)) {
        if (leftHand(w, l)) continue;
        for (const [i, r] of new Ways(w, l, s, max + 100).at)
          if (r.len >= min && r.len <= max && r.cost <= r.len * 1.4 && !sameStop(w, from, i) && !sameStop(w, this.start0, i) && !out.some((o) => sameStop(w, o, i))) out.push(i);
      }
    }
    return out.length ? this.sim.rng.pick(out) : -1;
  }

  // ------------------------------------------------------------------------ the city's inspectors
  private stepNpc(n: Npc, dt: number) {
    const sim = this.sim, w = sim.world, ped = n.ped, now = sim.time;
    const dodger = [...this.riders.values()].find((r) => r.role === 'dodger' && !r.done);
    if (!dodger) return;
    // knocked off their feet (the game moves them itself, so nothing else gets them up): a few
    // seconds on the ground, then back to their stop
    if (ped.state !== 'walk' && ped.state !== 'idle') {
      n.down += dt;
      if (n.down < DOWN_S) return;
      n.down = 0;
      ped.state = 'idle';
      ped.health = 100;
      ped.vx = ped.vy = 0;
      if (n.chase && !n.chase.done) this.giveUp(n);
      n.state = 'back';
      return;
    }
    const walkTo = (x: number, y: number, speed: number) => {
      const d = dist(ped.x, ped.y, x, y);
      if (d < 0.3) {
        ped.move(dt, w, 0, 0);
        ped.state = 'idle';
        return true;
      }
      const v = Math.min(speed, d / dt);
      ped.move(dt, w, ((x - ped.x) / d) * v, ((y - ped.y) / d) * v);
      ped.state = 'walk';
      return false;
    };
    const standing = (t: Tram | null) => !!t && sim.trams.includes(t) && t.speed < 0.5;
    const offHere = () => !dodger.on && now - dodger.offAt < 3 && dist(dodger.p.ped.x, dodger.p.ped.y, ped.x, ped.y) < SEE_OFF;
    switch (n.state) {
      case 'wait': {
        walkTo(n.spot.x, n.spot.y, WALK);
        if (ped.state === 'idle') ped.angle = n.spot.a;
        // the dodger's tram at their stop: in they go
        const t = dodger.on;
        const at = t && t.dwell > 0.3 ? stopAt(w, t.x, t.y) : -1;
        if (t && at >= 0 && sameStop(w, at, n.home) && dist(t.x, t.y, ped.x, ped.y) < 60) {
          n.state = 'board';
          n.tram = t;
          this.msg(dodger.p, 'Revízor nastupuje! Vystúp, kým ťa skontroluje!', '#ff5252', 3);
        } else if (offHere()) this.startChase(n, dodger);
        break;
      }
      case 'board': {
        const t = n.tram!;
        if (!standing(t)) {
          n.state = 'back';
          break;
        }
        if (dodger.on !== t && offHere()) {
          this.startChase(n, dodger);
          break;
        }
        const door = doorNear(t, ped.x, ped.y);
        if (walkTo(door.x, door.y, HURRY) || dist(ped.x, ped.y, door.x, door.y) < 0.8) {
          n.state = 'aboard';
          n.check = 0;
          ped.aboard = t;
          ped.vx = ped.vy = 0;
          this.pop(dodger.p, 'Lístky, prosím!', ped.x, ped.y - 1.7);
        }
        break;
      }
      case 'aboard': {
        const t = n.tram!;
        if (!sim.trams.includes(t)) {
          this.alightNpc(n, t);
          n.state = 'back';
          break;
        }
        const mid = t.sections[Math.min(1, t.sections.length - 1)];
        ped.x = mid?.x ?? t.x;
        ped.y = mid?.y ?? t.y;
        ped.level = t.level;
        ped.angle = t.angle;
        if (dodger.on === t) {
          n.check += dt;
          if (n.check >= CHECK_NPC) this.caughtByNpc(n, dodger);
          break;
        }
        // the dodger isn't aboard (any more): off at the next standstill, after them if they're near
        if (!standing(t)) break;
        this.alightNpc(n, t);
        if (offHere()) this.startChase(n, dodger);
        else {
          const at = stopAt(w, t.x, t.y, 6);
          if (at >= 0) this.moveHome(n, at);
          n.state = 'back';
        }
        break;
      }
      case 'chase': {
        const r = n.chase!;
        const t = r.on;
        if (t) {
          // back on a tram: in after them while its doors are open, else they got away
          if (standing(t) && dist(ped.x, ped.y, t.x, t.y) < 40) {
            const door = doorNear(t, ped.x, ped.y);
            if (walkTo(door.x, door.y, RUN) || dist(ped.x, ped.y, door.x, door.y) < 1) {
              n.state = 'aboard';
              n.tram = t;
              n.check = 0;
              ped.aboard = t;
            }
          } else this.giveUp(n);
          break;
        }
        const f = r.p.focus();
        const d = dist(ped.x, ped.y, f.x, f.y);
        if (d <= REACH && !r.p.ped.vehicle) return this.caughtByNpc(n, r);
        if (now > n.until || d > 45 || (r.p.ped.vehicle?.speed ?? 0) > 4) return this.giveUp(n);
        walkTo(f.x, f.y, RUN);
        break;
      }
      case 'back': {
        // far from their stop and out of sight: they're simply back at it
        if (dist(ped.x, ped.y, n.spot.x, n.spot.y) > 60 && !sim.visibleToAny(ped.x, ped.y, 5) && !sim.visibleToAny(n.spot.x, n.spot.y, 5)) {
          ped.x = n.spot.x;
          ped.y = n.spot.y;
        }
        if (walkTo(n.spot.x, n.spot.y, WALK)) {
          n.state = 'wait';
          ped.angle = n.spot.a;
        } else if (offHere()) this.startChase(n, dodger);
        break;
      }
    }
  }

  private startChase(n: Npc, r: Rider) {
    n.state = 'chase';
    n.chase = r;
    n.until = this.sim.time + CHASE_S;
    this.msg(r.p, 'Revízor ťa videl vystúpiť – bež!', '#ff5252', 2.5);
  }

  private giveUp(n: Npc) {
    if (n.chase && !n.chase.done) this.msg(n.chase.p, 'Revízor to vzdal. Na kamere si len rozmazaný fľak.', '#69f0ae', 3);
    n.state = 'back';
    n.chase = null;
  }

  /** off tram `t` at the door nearest the platform */
  private alightNpc(n: Npc, t: Tram) {
    const ped = n.ped;
    const door = doorNear(t, n.spot.x, n.spot.y);
    ped.aboard = null;
    ped.x = door.x;
    ped.y = door.y;
    ped.level = t.level;
    n.tram = null;
  }

  /** stop `i` is where an inspector waits from now on */
  private moveHome(n: Npc, i: number) {
    n.home = i;
    n.spot = platform(this.sim.world, i, this.sim.rng.range(-5, 5));
  }

  private caughtByNpc(n: Npc, r: Rider) {
    const sim = this.sim;
    sim.addMoney(r.p, -FINE);
    r.done = true;
    const text = `Pokuta ${FINE} €. Revízor s kamerou si ťa natočil.`;
    this.outcome(r.p, { pay: 0, text });
    this.msg(r.p, text, '#ff5252', 4);
    this.pop(r.p, `-${FINE} €`, r.p.ped.x, r.p.ped.y - 1.7);
    n.state = 'back';
    n.chase = null;
    this.finish();
  }

  // --------------------------------------------------------------------- the players' inspectors
  /** with others: an inspector aboard with a dodger for a few seconds, or on foot right after they
   *  got off, catches them */
  private inspect(dt: number) {
    if (!this.group) return;
    const now = this.sim.time;
    const all = [...this.riders.values()];
    for (const q of all) {
      if (q.role !== 'inspector' || q.p.state !== 'play') continue;
      for (const d of all) {
        if (d.role !== 'dodger' || d.p.state !== 'play' || now < d.immune) {
          q.checks.delete(d.p.id);
          continue;
        }
        if (q.on && d.on === q.on) {
          const c = (q.checks.get(d.p.id) ?? 0) + dt;
          q.checks.set(d.p.id, c);
          if (c >= CHECK_PLAYER) this.catch(q, d);
          continue;
        }
        q.checks.delete(d.p.id);
        if (!q.on && !d.on && !q.p.ped.vehicle && now - d.offAt <= OFF_RECENT && dist(q.p.ped.x, q.p.ped.y, d.p.ped.x, d.p.ped.y) <= REACH) this.catch(q, d);
      }
    }
  }

  private catch(q: Rider, d: Rider) {
    const sim = this.sim;
    sim.addMoney(d.p, -FINE);
    d.caught++;
    d.immune = sim.time + IMMUNE_S;
    d.escort = !!d.on;
    this.addPoints(d.p, -Math.min(PTS_CAUGHT, this.pointsOf(d.p)));
    q.catches++;
    q.checks.delete(d.p.id);
    this.addPoints(q.p, PTS_CATCH);
    this.msg(d.p, `Revízor ${q.p.nick} ťa chytil! Pokuta ${FINE} €, a je to na kamere.`, '#ff5252', 3.5);
    this.msg(q.p, `Chytil si ${d.p.nick}! Pokuta ${FINE} € je tvoja.`, '#69f0ae', 3);
    this.pop(q.p, `+${PTS_CATCH}`, d.p.ped.x, d.p.ped.y - 1.7);
  }

  // ------------------------------------------------------------------------------- the trams
  /** the round's trams: one coming for each player waiting at a stop, on the way to their target;
   *  any other a dodger rides turned onto theirs; and none stuck nose to nose with one of the city's */
  private serve(dt: number) {
    const sim = this.sim, w = sim.world;
    this.runs = this.runs.filter((r) => sim.trams.includes(r.t));
    // who's waiting where, for which stop
    const waiting: { r: Rider; b: NonNullable<Rider['board']> }[] = [];
    for (const r of this.riders.values()) {
      if (r.done || r.on || r.p.state !== 'play' || r.p.ped.vehicle) continue;
      const goal = this.goalOf(r);
      if (goal < 0) continue;
      const near = nearestStop(w, r.p.ped.x, r.p.ped.y, WAIT_R);
      if (near < 0 || (r.role === 'dodger' && sameStop(w, near, goal))) {
        r.board = null;
        continue;
      }
      if (!r.board || !sameStop(w, r.board.from, near) || r.board.at < sim.time - 10) r.board = this.boardAt(near, goal);
      if (r.board) waiting.push({ r, b: r.board });
    }
    // the trams' stops ahead (to where they're going), and who they're for
    const due = new Map<Run, number[]>();
    for (const run of this.runs) due.set(run, this.stopsAhead(run));
    for (const run of [...this.runs]) {
      const needed = carrying(sim, run.t) || waiting.some(({ b }) => due.get(run)!.includes(b.i));
      if (needed) continue;
      // nobody's on it or waiting for it: one of the city's goes its own way again, the round's own
      // goes once nobody sees it
      if (!run.own) {
        run.t.follow([]);
        this.runs.splice(this.runs.indexOf(run), 1);
      } else if (!due.get(run)!.length && !sim.visibleToAny(run.t.x, run.t.y, 30)) this.dropRun(run);
    }
    for (const { b } of waiting) {
      if (this.runs.some((run) => due.get(run)?.includes(b.i)) || sim.time - (this.sent.get(b.i) ?? -1e9) < RESEND_S) continue;
      // (a tram of the city's standing right there with its doors open will do)
      if (sim.trams.some((t) => t.dwell > 0.3 && stopAt(w, t.x, t.y) === b.i)) continue;
      this.dispatch(b);
    }
    // a dodger on a tram that isn't running for the round: now it is (the first one aboard says where)
    for (const r of this.riders.values()) if (r.on && r.role === 'dodger' && !r.done && !this.runs.some((q) => q.t === r.on)) this.adopt(r.on, r.target);
    // two trams nose to nose on one rail never move again: the city's one goes; and a car parked on
    // the track is towed
    for (const run of this.runs) {
      // (held up, it creeps on and stops again: crawling away from a stop is stuck)
      run.stuck = run.t.dwell <= 0 && run.t.speed < 1.5 ? run.stuck + dt : 0;
      const ahead = trackAhead(w, run.t, 250, 0, this.rest(run)).pts;
      clearAhead(sim, run.t, ahead, run.stuck > STUCK_S, (o) => carrying(sim, o) || this.runs.some((q) => q.t === o));
      if (run.stuck > STUCK_S) this.unblock(run);
    }
  }

  /** What holds up a round tram that's stood stuck a while (the city's trams wait for whatever's
   *  in front of them): a car of the city's parked on the track is towed (one in traffic, after a
   *  while longer), a person of the city's standing on it steps off. */
  private unblock(run: Run) {
    const sim = this.sim, t = run.t;
    const fx = Math.cos(t.angle), fy = Math.sin(t.angle);
    const lat = (x: number, y: number) => -(x - t.x) * fy + (y - t.y) * fx;
    const inFront = (x: number, y: number, r: number) => {
      const lon = (x - t.x) * fx + (y - t.y) * fy;
      return lon > -1 && lon < 14 && Math.abs(lat(x, y)) < 1.3 + r;
    };
    for (const v of sim.vehiclesNear(t.x, t.y, 20)) {
      if (v.isPlayer || v.owner || v.mission || v.kinematic || !inFront(v.x, v.y, v.spec.width / 2)) continue;
      if (v.driver && !v.parked && run.stuck < STUCK_S * 4) continue;
      if (v.driver && !v.driver.playerId) sim.peds = sim.peds.filter((q) => q !== v.driver);
      sim.removeVehicle(v);
      for (const r of this.riders.values()) if (r.on === t) this.msg(r.p, 'Odťahovka odtiahla auto z koľají. Konečne.', '#b2ff59');
    }
    for (const q of sim.pedsNear(t.x, t.y, 12)) {
      if (q.playerId || q.kinematic || q.vehicle || !inFront(q.x, q.y, 0.3)) continue;
      const side = lat(q.x, q.y) >= 0 ? 1 : -1;
      q.x -= fy * side * 3;
      q.y += fx * side * 3;
    }
  }

  /** where a rider is heading: a dodger their target, an inspector the nearest dodger's */
  private goalOf(r: Rider): number {
    if (r.role === 'dodger') return r.target;
    let best = -1, bd = Infinity;
    for (const d of this.riders.values()) {
      if (d.role !== 'dodger') continue;
      const dd = dist(d.p.ped.x, d.p.ped.y, r.p.ped.x, r.p.ped.y);
      if (dd < bd) (bd = dd), (best = d.target);
    }
    return best;
  }

  /** the platform of stop `near` (either of its entries) to board at for `goal`, and the way on */
  private boardAt(near: number, goal: number): Rider['board'] {
    const w = this.sim.world;
    let best: Rider['board'] = null, bc = Infinity;
    for (let j = 0; j < w.tramStops.length; j += 2) {
      if (!sameStop(w, near, j)) continue;
      for (const { l, s } of linksAt(w, j)) {
        if (leftHand(w, l)) continue;
        const ways = new Ways(w, l, s, 4000);
        for (const [i, r] of ways.at) if (sameStop(w, i, goal) && r.cost < bc) (bc = r.cost), (best = { i: j, l, s, from: near, at: this.sim.time });
      }
    }
    return best;
  }

  /** the way on from `l` (at `s` along it) to the nearest platform of stop `goal`, or null */
  private wayTo(l: Link, s: number, goal: number): Link[] | null {
    const w = this.sim.world;
    const ways = new Ways(w, l, s, 4000);
    let best = -1, bc = Infinity;
    for (const [i, r] of ways.at) if (sameStop(w, i, goal) && r.cost < bc) (bc = r.cost), (best = i);
    return best >= 0 ? ways.to(best) : null;
  }

  /** the links a run has still to go (after the one it's on) */
  private rest(run: Run): Link[] {
    const k = run.way.indexOf(run.t.link);
    if (k >= 0) return run.way.slice(k + 1);
    return run.t.link === run.on ? run.way : [];
  }

  /** the stops a run will stand at on its way, up to where it's going */
  private stopsAhead(run: Run): number[] {
    const w = this.sim.world;
    const rest = this.rest(run);
    const len = rest.reduce((a, l) => a + l.edge.len, run.t.link.edge.len);
    const out: number[] = [];
    for (const s of trackAhead(w, run.t, len + 5, 0, rest).stops) {
      // (not the one it stands at, or is just pulling away from)
      if (s.d < 2) continue;
      out.push(s.i);
      if (sameStop(w, s.i, run.to)) break;
    }
    return out;
  }

  /** send one of the round's own trams to platform `b.i`, from out of sight up the track, on to the
   *  target beyond */
  private dispatch(b: NonNullable<Rider['board']>) {
    const sim = this.sim, w = sim.world;
    const own = this.runs.filter((r) => r.own);
    if (own.length >= (this.group ? OWN_GROUP : OWN_SOLO)) {
      // make room: one nobody's on, ahead of nobody, out of sight
      const spare = own.find((r) => !carrying(sim, r.t) && !sim.visibleToAny(r.t.x, r.t.y, 30));
      if (!spare) return;
      this.dropRun(spare);
    }
    const goal = [...this.riders.values()].find((r) => r.board === b);
    const to = goal ? this.goalOf(goal) : this.target0;
    const on = this.wayTo(b.l, b.s, to);
    if (!on) return;
    // in from up the track, as near as it can be while nobody sees it come (and near enough that
    // the AI, which keeps trams only around the players, leaves it be)
    const lead = leadIn(w, b.l, LEAD_AT[LEAD_AT.length - 1] + 60);
    let got: { t: Tram; on: Link; way: Link[] } | null = null;
    for (const back of LEAD_AT) {
      const put = upTrack(lead, b.l, b.s, back);
      if (!put) continue;
      const way = [...put.then, ...on];
      const t = tramOn(w, sim.rng, put.link, way, put.at);
      if (!t) continue;
      got = { t, on: put.link, way };
      if (!sim.visibleToAny(t.x, t.y, 30)) break;
    }
    if (!got) return;
    const t = got.t;
    if (sim.trams.some((o) => o.level === t.level && dist(o.x, o.y, t.x, t.y) < 45)) return;
    sim.addTram(t);
    this.sent.set(b.i, sim.time);
    this.runs.push({ t, own: true, to, on: got.on, way: got.way, stuck: 0 });
  }

  /** tram `t` (one of the city's, or the round's) runs on to stop `to` */
  private adopt(t: Tram, to: number) {
    const run = this.runs.find((r) => r.t === t);
    if (t.driver || (run && sameStop(this.sim.world, run.to, to))) return;
    const way = this.wayTo(t.link, tramAlong(t), to);
    if (!way) return;
    t.follow(way);
    if (run) Object.assign(run, { to, on: t.link, way });
    else this.runs.push({ t, own: false, to, on: t.link, way, stuck: 0 });
  }

  /** one of the round's own trams leaves the city (anyone aboard is put down beside it by Trams) */
  private dropRun(run: Run) {
    this.runs.splice(this.runs.indexOf(run), 1);
    if (run.own) this.sim.trams = this.sim.trams.filter((t) => t !== run.t);
    else run.t.follow([]);
  }

  // ----------------------------------------------------------------------------- the výluka
  /** alone, half the rounds: with the target a stop or two ahead, it moves on */
  private twist() {
    if (!this.vyluka || this.vylukaDone || this.group) return;
    const r = this.riders.get(this.players[0]?.id ?? -1);
    if (!r || r.done || !r.on || r.ridden < 1 || r.on.speed < 3) return;
    const run = this.runs.find((q) => q.t === r.on);
    const left = run ? this.stopsAhead(run).findIndex((i) => sameStop(this.sim.world, i, r.target)) : -1;
    if (left < 0 || left > 1) return;
    this.vylukaDone = true;
    const w = this.sim.world;
    const next = this.nextTarget(r.target, MOVE_MIN, MOVE_MAX);
    if (next < 0) return;
    this.closed = r.target;
    r.target = next;
    r.board = r.hint = null;
    for (const q of this.runs) if (sameStop(w, q.to, this.closed)) this.adopt(q.t, next);
    this.msg(r.p, 'Výluka! Náhradná doprava nejazdí.', '#ffab40', 4);
    this.msg(r.p, `Nový cieľ: ${stopName(w, next)}`, '#ffd740', 4);
  }

  // ------------------------------------------------------------------------------ the end
  onTimeout() {
    this.settle();
  }

  /** it's over as it stands: alone, out of time (a little for the stops ridden); with others, each
   *  gets their points in € (a dodger the stops and targets, an inspector the fines they took) */
  private settle() {
    for (const r of this.riders.values()) {
      if (r.done) continue;
      if (!this.group) {
        this.outcome(r.p, { pay: PAY_LATE_STOP * r.ridden, text: r.ridden ? `Čas vypršal. Aspoň si sa zviezol ${stops(r.ridden)} zadarmo.` : 'Čas vypršal – do cieľa si nedošiel.' });
        continue;
      }
      const pts = this.pointsOf(r.p);
      const text =
        r.role === 'inspector'
          ? r.catches
            ? `Chytil si ${r.catches}× čierneho pasažiera.`
            : 'Nikoho si nechytil – čierni pasažieri sú rýchlejší.'
          : `${stops(r.ridden)} zadarmo, ${r.targets}× v cieli${r.caught ? `, ${r.caught}× pokuta` : ''}.`;
      this.outcome(r.p, { pay: pts, text });
    }
    this.finish();
  }

  onLeave(p: SimPlayer) {
    this.riders.delete(p.id);
    for (const n of this.npcs) if (n.chase?.p === p) n.chase = null;
  }

  dispose() {
    // the round's own trams go, unless someone's still aboard (then it's one of the city's now), and
    // the city's go their own way again
    for (const run of this.runs) {
      run.t.follow([]);
      if (run.own && !carrying(this.sim, run.t)) this.sim.trams = this.sim.trams.filter((t) => t !== run.t);
    }
    this.runs = [];
    for (const n of this.npcs) n.ped.aboard = null;
    super.dispose();
  }

  // -------------------------------------------------------------------------------- the view
  view(p: SimPlayer): MiniView {
    const r = this.riders.get(p.id);
    if (!r) return { goal: 'Revízor' };
    return r.role === 'inspector' ? this.inspectorView(r) : this.dodgerView(r);
  }

  private dodgerView(r: Rider): MiniView {
    const sim = this.sim, w = sim.world, S = w.tramStops, now = sim.time;
    const marks: MiniMark[] = [];
    const tname = stopName(w, r.target);
    const run = r.on ? this.runs.find((q) => q.t === r.on) : null;
    const ahead = run ? this.stopsAhead(run) : [];
    const left = ahead.findIndex((i) => sameStop(w, i, r.target));
    // where to board, while on foot
    const b = !r.on && !r.done ? (r.board ?? this.boardFor(r)) : null;
    // (on the platform, beside the track: whoever stands on it holds the tram up)
    const pl = b ? platform(w, b.i) : null;
    if (b && pl) marks.push({ x: Math.round(pl.x), y: Math.round(pl.y), icon: '🚏', label: `nástup: ${stopName(w, b.i)}`, color: '#90caf9', r: 3, arrow: 1 });
    marks.push({ x: Math.round(S[r.target]), y: Math.round(S[r.target + 1]), icon: '🏁', label: `cieľ: ${tname}`, color: '#69f0ae', r: 10, arrow: r.on ? 1 : undefined });
    if (this.closed >= 0) marks.push({ x: Math.round(S[this.closed]), y: Math.round(S[this.closed + 1]), icon: '🚧', label: 'výluka', color: '#ffab40', r: 6, dim: 1 });
    // the stops still to go on this tram
    for (const i of ahead.slice(0, Math.max(0, left))) marks.push({ x: Math.round(S[i]), y: Math.round(S[i + 1]), label: stopName(w, i), color: '#b0bec5', r: 2.5, noMap: 1 });
    // the tram coming for them
    const coming = !r.on && r.board ? this.runs.find((q) => this.stopsAhead(q).includes(r.board!.i)) : null;
    if (coming) marks.push({ x: Math.round(coming.t.x), y: Math.round(coming.t.y), icon: '🚋', label: 'tvoja električka', color: '#ef5350', r: 3 });
    // the inspectors
    let checking = 0, chasing = 0;
    for (const n of this.npcs) {
      if (n.state === 'aboard' && n.tram === r.on && r.on) checking = Math.max(checking, n.check / CHECK_NPC);
      if (n.state === 'chase' && n.chase === r) chasing = Math.max(chasing, (n.until - now) / CHASE_S);
      if (n.state === 'aboard') continue;
      marks.push({ x: Math.round(n.ped.x), y: Math.round(n.ped.y), e: n.ped.id, icon: '🎫', label: n.state === 'chase' ? 'revízor!' : 'revízor', color: '#b388ff', r: 1.5 });
    }
    for (const q of this.riders.values()) {
      if (q.role !== 'inspector') continue;
      marks.push({ x: Math.round(q.p.ped.x), y: Math.round(q.p.ped.y), e: q.p.ped.id, icon: '🎫', label: q.p.nick, color: '#b388ff', r: 1.5 });
      const c = q.checks.get(r.p.id);
      if (c) checking = Math.max(checking, c / CHECK_PLAYER);
    }
    const goal = r.done
      ? 'Hotovo.'
      : checking > 0
        ? 'Revízor kontroluje lístky! Vystúp, kým príde k tebe!'
        : chasing > 0
          ? 'Revízor ťa naháňa – bež (Shift)!'
          : r.on
            ? left >= 0
              ? `Vez sa do zastávky ${tname}${left ? ` – ešte ${stops(left)}` : ' – tu vystúp!'}`
              : `Táto električka ide inam – vystúp a prestúp smer ${tname}`
            : r.board
              ? `Čakaj na električku smer ${tname} a nastúp (F pri dverách).`
              : b
                ? `Choď na zastávku ${stopName(w, b.i)} a odtiaľ električkou smer ${tname}`
                : `Choď na zastávku a nastúp do električky smer ${tname}`;
    const stats: [string, string][] = [['Zastávky', `${r.ridden}`]];
    if (this.group) stats.push(['V cieli', `${r.targets}×`]);
    else stats.push(['Peniaze', `€${Math.floor(r.p.profile.money)}`]);
    const bar = checking > 0 ? { label: 'Kontrola lístkov', v: checking, color: '#ff5252' } : chasing > 0 ? { label: 'Revízor za tebou', v: chasing, color: '#ffab40' } : undefined;
    return { goal, stats, bar, marks };
  }

  private inspectorView(r: Rider): MiniView {
    const w = this.sim.world, S = w.tramStops;
    const marks: MiniMark[] = [];
    let best: Rider | null = null, bd = Infinity, checking = 0;
    for (const d of this.riders.values()) {
      if (d.role !== 'dodger') continue;
      const dd = dist(d.p.ped.x, d.p.ped.y, r.p.ped.x, r.p.ped.y);
      if (dd < bd) (bd = dd), (best = d);
      const fresh = this.sim.time - d.offAt <= OFF_RECENT && !d.on;
      marks.push({ x: Math.round(d.p.ped.x), y: Math.round(d.p.ped.y), e: d.p.ped.id, icon: '🏃', label: fresh ? `${d.p.nick} – chyť ho!` : d.p.nick, color: '#ff5252', r: 1.5 });
      marks.push({ x: Math.round(S[d.target]), y: Math.round(S[d.target + 1]), icon: '🏁', label: `cieľ: ${d.p.nick}`, color: '#69f0ae', r: 6, dim: 1 });
      checking = Math.max(checking, (r.checks.get(d.p.id) ?? 0) / CHECK_PLAYER);
    }
    if (best) marks[marks.findIndex((m) => m.e === best!.p.ped.id)].arrow = 1;
    const goal = checking > 0 ? 'Kontroluješ lístky… nepusť ho!' : 'Chyť čiernych pasažierov: 5 s s nimi v električke, alebo ich dobehni, keď vystúpia.';
    return {
      goal,
      stats: [['Chytení', `${r.catches}`]],
      bar: checking > 0 ? { label: 'Kontrola', v: checking, color: '#b388ff' } : undefined,
      marks,
    };
  }

  /** where a dodger on their way to a stop would best board: the nearest stop with no inspector
   *  waiting at it, if there's one not much further (kept while it stays the one) */
  private boardFor(r: Rider): Rider['board'] {
    const w = this.sim.world, x = r.p.ped.x, y = r.p.ped.y;
    const ok = (i: number) => !sameStop(w, i, r.target) && i !== this.closed;
    const guarded = (i: number) => this.npcs.some((n) => n.state === 'wait' && sameStop(w, n.home, i));
    const near = nearestStop(w, x, y, 800, ok);
    if (near < 0) return null;
    const free = nearestStop(w, x, y, dist(x, y, w.tramStops[near], w.tramStops[near + 1]) + 250, (i) => ok(i) && !guarded(i));
    const from = free >= 0 ? free : near;
    if (r.hint && sameStop(w, r.hint.from, from)) return r.hint;
    return (r.hint = this.boardAt(from, r.target));
  }

  lobbyView(): MiniView {
    const w = this.sim.world, S = w.tramStops, pl = platform(w, this.start0);
    return {
      goal: `Bez lístka na zastávku ${stopName(w, this.target0)} – revízori s kamerami už čakajú…`,
      marks: [
        { x: Math.round(pl.x), y: Math.round(pl.y), icon: '🚏', label: stopName(w, this.start0), color: '#90caf9', r: 3, arrow: 1 },
        { x: Math.round(S[this.target0]), y: Math.round(S[this.target0 + 1]), icon: '🏁', label: `cieľ: ${stopName(w, this.target0)}`, color: '#69f0ae', r: 10 },
      ],
    };
  }
}

export const REVIZOR_DEF: MiniGameDef = {
  kind: 'revizor',
  lobby: 20,
  create(sim, round) {
    const g = new Revizor(sim, round);
    return g.pick(round.x, round.y) ?? g;
  },
};
