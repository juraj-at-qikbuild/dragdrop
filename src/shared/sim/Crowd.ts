// People among people (shared by the browser and the game server): bodies that make room for each
// other instead of walking through one another, and what people do besides walking the streets.
// They sit down on benches, in bus shelters and at café tables, wait at tram stops and get on the
// tram (and off it), put their hands up at a gun pointed at them, step out of the way of a honking
// car, tell off whoever barges into them, square up to a player who goes for them (the odd one),
// and phone the police about a crime they saw, unless the player stops them first.
import { Ped } from '../entities/Ped';
import type { Tram } from '../entities/Tram';
import type { Vehicle } from '../entities/Vehicle';
import { F_BENCH, F_SHELTER, F_TABLE } from '../world/Street';
import { dist } from '../util/math';
import { SAY_BUMP, SAY_CHAT, SAY_FIGHT, SAY_GUN, SAY_HORN, SAY_PHONE, pickLine } from './phrases';
import type { Sim } from './Sim';
import type { SimPlayer } from './SimPlayer';

const F_PICNIC = 14;

/** where people sit on each kind of seat, in its own frame (it faces +x): flat x, y, facing */
const SEATS: Record<number, number[]> = {
  [F_BENCH]: [0.12, -0.45, 0, 0.12, 0.45, 0],
  [F_SHELTER]: [-0.36, -0.9, 0, -0.36, 0.05, 0, -0.36, 0.95, 0],
  // round the table, facing it (the chairs of StreetDetail's café table)
  [F_TABLE]: [0, 1, 2, 3].flatMap((s) => {
    const a = (s / 4) * Math.PI * 2 + 0.3;
    return [Math.cos(a) * 0.62, Math.sin(a) * 0.62, a + Math.PI];
  }),
  [F_PICNIC]: [-0.64, -0.45, 0, -0.64, 0.45, 0, 0.64, -0.45, Math.PI, 0.64, 0.45, Math.PI],
};
/** how long people stay sitting (s): a bench, a café table */
const SIT = [15, 70], COFFEE = [50, 160];
/** a witness phones for this long (s) before the police are on their way */
const CALL = 7;
/** no more than this many wait at one tram stop */
const MAX_WAITING = 5;

export class Crowd {
  /** the witness on the phone about each player (player id -> witness) */
  private calls = new Map<number, Ped>();
  /** people who got on a tram this update (they leave the simulation) */
  private gone = new Set<Ped>();
  /** trams standing at a stop (to let people off once per stop) */
  private dwelling = new WeakSet<Tram>();
  /** the track's direction at each tram stop (lazily) */
  private stopDir: Float32Array | null = null;
  private aimTimer = 0;
  private tramTimer = 0;

  constructor(private sim: Sim) {}

  /** after the AI has moved everyone: bodies apart, guns pointed, trams at their stops, the calls */
  update(dt: number) {
    this.separate();
    if ((this.aimTimer -= dt) <= 0) {
      this.aimTimer = 0.2;
      this.gunsPointed();
    }
    if ((this.tramTimer -= dt) <= 0) {
      this.tramTimer = 0.5;
      this.trams();
    }
    if (this.calls.size) this.checkCalls();
    if (this.gone.size) {
      this.sim.peds = this.sim.peds.filter((p) => !this.gone.has(p));
      this.gone.clear();
    }
  }

  /** AI.updatePed hands every civilian here first: true when the crowd took care of them. `group`:
   *  they walk with a group (and don't wander off to sit down). */
  updatePed(p: Ped, dt: number, group: boolean): boolean {
    switch (p.state) {
      case 'sit':
        return this.sitting(p, dt);
      case 'phone':
        return this.phoning(p, dt);
      case 'fight':
        return this.fighting(p, dt);
      case 'flee':
        // a witness who has got far enough away dials
        if (p.callPid && p.timer - dt <= 0) {
          this.dial(p);
          return true;
        }
        return false;
      case 'idle':
        return p.waitStop >= 0 && p.surrender <= 0 ? this.waiting(p, dt) : false;
      case 'walk':
        if (!p.goal && !group) this.lookAround(p);
        return p.goal ? this.toGoal(p, dt) : false;
    }
    return false;
  }

  // ------------------------------------------------------------------ bodies
  /** Two people closer than their radii are eased apart, half each; a player's figure, a mirror of
   *  one and someone sitting down don't budge (the other takes it all). A player barging into
   *  someone gets told off. */
  private separate() {
    const sim = this.sim;
    for (const p of sim.peds) {
      if (p.dead || p.vehicle) continue;
      sim.forPedsNear(p.x, p.y, 1, (q) => {
        if (q.id <= p.id || q.dead || q.vehicle || q.level !== p.level) return;
        const dx = q.x - p.x, dy = q.y - p.y, rr = p.r + q.r, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) return;
        const fp = this.fixed(p), fq = this.fixed(q);
        if (fp && fq) return;
        const d = Math.sqrt(d2);
        // right on top of each other: apart some way (their own)
        const nx = d > 1e-4 ? dx / d : Math.cos(p.seed), ny = d > 1e-4 ? dy / d : Math.sin(p.seed);
        const over = rr - d, kp = fp ? 0 : fq ? 1 : 0.5;
        this.push(p, -nx * over * kp, -ny * over * kp);
        this.push(q, nx * over * (1 - kp), ny * over * (1 - kp));
        if (p.playerId && !q.playerId) this.bumped(q, p);
        else if (q.playerId && !p.playerId) this.bumped(p, q);
      });
    }
  }

  private fixed(p: Ped) {
    return !!p.playerId || p.kinematic || p.state === 'sit';
  }

  /** shift someone (not into a wall) */
  private push(p: Ped, dx: number, dy: number) {
    if (!dx && !dy) return;
    p.x += dx;
    p.y += dy;
    const hit = this.sim.world.collideCircle(p.x, p.y, p.r, p.level);
    if (hit) (p.x += hit.nx * hit.depth), (p.y += hit.ny * hit.depth);
  }

  /** player figure `pl` barged into `q`: a look and a word (and the odd one shoves back) */
  private bumped(q: Ped, pl: Ped) {
    const sim = this.sim;
    const sp = Math.hypot(pl.vx, pl.vy);
    if (sp < 1.8 || q.kind !== 'civ' || q.state === 'flee' || q.state === 'fight' || q.state === 'phone') return;
    // sent staggering by someone running
    if (sp > 5 && q.state !== 'sit') this.push(q, (pl.vx / sp) * 0.45, (pl.vy / sp) * 0.45);
    if (sim.time - q.saidAt < 5) return;
    q.angle = Math.atan2(pl.y - q.y, pl.x - q.x);
    const player = sim.players.get(pl.playerId);
    if (sp > 5 && player && sim.rng.chance(0.35) && this.provoke(q, player)) return;
    this.say(q, SAY_BUMP);
    // stop and stare a moment
    if (q.state === 'walk' && !q.goal) {
      q.state = 'idle';
      q.timer = 0.7 + sim.rng.next() * 0.6;
    }
  }

  /** someone says a line from `cat` (a speech bubble on clients) */
  say(p: Ped, cat: number) {
    const sim = this.sim;
    p.saidAt = sim.time;
    sim.events.say(p.id, p.x, p.y, pickLine(cat, p.archetype === 'tourist', sim.rng.next()));
  }

  // ----------------------------------------------------------- guns and horns
  /** A player on foot pointing a gun at someone close with a clear view: most put their hands up
   *  (and keep them up while it stays on them), the rest run. */
  private gunsPointed() {
    const sim = this.sim;
    for (const pl of sim.players.values()) {
      const me = pl.ped;
      if (pl.state !== 'play' || me.vehicle || me.dead || me.weapon === 'fist') continue;
      const fx = Math.cos(me.angle), fy = Math.sin(me.angle);
      sim.forPedsNear(me.x + fx * 5, me.y + fy * 5, 7, (q) => {
        if (q.kind !== 'civ' || q.dead || q.vehicle || q.level !== me.level) return;
        const dx = q.x - me.x, dy = q.y - me.y, lon = dx * fx + dy * fy;
        if (lon < 0.5 || lon > 10 || Math.abs(-dx * fy + dy * fx) > 0.45 + lon * 0.08) return;
        if (q.state === 'flee') return;
        if (q.surrender > 0) {
          // still covered: hands stay up
          q.surrender = Math.max(q.surrender, 2);
          q.timer = Math.max(q.timer, 2);
          return;
        }
        if (sim.world.raycast(me.x, me.y, q.x, q.y, me.level) < 1) return;
        this.threatened(q, me);
      });
    }
  }

  private threatened(q: Ped, by: Ped) {
    const sim = this.sim;
    this.hangUp(q);
    q.goal = null;
    q.waitStop = -1;
    q.targetPid = 0;
    if (q.fighter || sim.rng.chance(0.3)) {
      sim.combat.scare(q, by.x, by.y);
      if (sim.rng.chance(0.4)) sim.events.scream(q.x, q.y);
      return;
    }
    // hands up, facing the gun
    q.state = 'idle';
    q.timer = 3 + sim.rng.next() * 2;
    q.surrender = q.timer;
    q.handsUp = true;
    q.angle = Math.atan2(by.y - q.y, by.x - q.x);
    this.say(q, SAY_GUN);
  }

  /** A car honks: whoever is in its way steps aside, and someone nearby may shout back. */
  honk(v: Vehicle) {
    const sim = this.sim;
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    let shouted = false;
    for (const q of sim.pedsNear(v.x, v.y, 16)) {
      if (q.kind !== 'civ' || q.dead || q.vehicle || q.level !== v.level || q.state === 'flee' || q.state === 'fight') continue;
      const dx = q.x - v.x, dy = q.y - v.y;
      const lon = dx * fx + dy * fy - v.spec.length / 2, lat = -dx * fy + dy * fx;
      if (lon > -1 && lon < 14 && Math.abs(lat) < v.spec.width / 2 + 1.2 && q.state !== 'sit') {
        // in its way: off its line, to the side they're nearer
        const side = Math.abs(lat) > 0.2 ? Math.sign(lat) : q.seed & 1 ? 1 : -1;
        const cx = q.x + fy * lat, cy = q.y - fx * lat;
        q.goal = null;
        q.state = 'flee';
        q.timer = 0.9 + sim.rng.next() * 0.4;
        q.fleeFrom.x = cx + fy * side;
        q.fleeFrom.y = cy - fx * side;
        // stepping aside isn't a panic: no screaming crowd
        q.cooldown = Math.max(q.cooldown, 2.5);
        if (!shouted && sim.time - q.saidAt > 4 && sim.rng.chance(0.35)) (shouted = true), this.say(q, SAY_HORN);
      } else if (!shouted && Math.hypot(dx, dy) < 10 && sim.time - q.saidAt > 6 && sim.rng.chance(0.4)) {
        shouted = true;
        q.angle = Math.atan2(-dy, -dx);
        this.say(q, SAY_HORN);
      }
    }
  }

  // ----------------------------------------------------------------- seats
  /** Now and then someone walking by a free seat sits down on it, or stops at a tram stop. */
  private lookAround(p: Ped) {
    const sim = this.sim;
    if (p.kind !== 'civ' || sim.time < p.restless) return;
    p.restless = sim.time + 3 + sim.rng.next() * 4;
    const r = sim.rng.next();
    if (r < 0.16) this.findSeat(p, 7);
    else if (r < 0.26) this.findTramStop(p);
  }

  /** the seats of furniture `i` (flat x, y, facing), none when it isn't something to sit on (nor
   *  the ones on, or right by, a street cars use: nobody sits with their back in the traffic) */
  private seatsOf(i: number): number[] {
    const w = this.sim.world, f = w.furniture, local = SEATS[f[i + 3]];
    if (!local) return [];
    const A = f[i + 2], c = Math.cos(A), s = Math.sin(A), out: number[] = [];
    for (let k = 0; k < local.length; k += 3) {
      const x = f[i] + c * local[k] - s * local[k + 1], y = f[i + 1] + s * local[k] + c * local[k + 1];
      if (!w.onCarriageway(x, y, 0.8)) out.push(x, y, A + local[k + 2]);
    }
    return out;
  }

  private seatFree(x: number, y: number) {
    let free = true;
    this.sim.forPedsNear(x, y, 1, (q) => {
      if (free && !q.dead && !q.vehicle && Math.abs(q.x - x) < 0.4 && Math.abs(q.y - y) < 0.4) free = false;
    });
    return free;
  }

  /** head for the nearest free seat within `r` in plain view, if there is one */
  private findSeat(p: Ped, r: number) {
    const sim = this.sim, w = sim.world;
    let best = Infinity, goal: Ped['goal'] = null;
    w.forFurnitureNear(p.x, p.y, r, (i) => {
      const s = this.seatsOf(i);
      for (let k = 0; k < s.length; k += 3) {
        const d = dist(p.x, p.y, s[k], s[k + 1]);
        if (d > r || d >= best || !this.seatFree(s[k], s[k + 1]) || w.raycast(p.x, p.y, s[k], s[k + 1], p.level) < 1) continue;
        best = d;
        goal = { x: s[k], y: s[k + 1], a: s[k + 2], kind: 'seat', ref: i };
      }
    });
    if (goal) this.setGoal(p, goal);
  }

  private setGoal(p: Ped, g: NonNullable<Ped['goal']>) {
    p.goal = g;
    p.state = 'walk';
    p.bestD = Infinity;
    p.timer = 0;
  }

  /** walk straight to the goal (a seat, a spot at a tram stop, a tram's door), and do what it's for */
  private toGoal(p: Ped, dt: number): boolean {
    const sim = this.sim, g = p.goal!;
    if (g.kind === 'board' && !this.tramAt(g.ref)) {
      // it left without them: wait for the next one
      p.goal = null;
      this.wait(p, g.ref);
      return true;
    }
    const d = dist(p.x, p.y, g.x, g.y);
    if (d < (g.kind === 'board' ? 0.7 : 0.3)) {
      p.goal = null;
      p.bestD = Infinity;
      p.timer = 0;
      if (g.kind === 'board') this.gone.add(p);
      else if (g.kind === 'stop') this.wait(p, g.ref, g.a);
      else if (this.seatFree(g.x, g.y) || (Math.abs(p.x - g.x) < 0.4 && Math.abs(p.y - g.y) < 0.4 && this.onlyMeAt(p, g.x, g.y))) {
        p.x = g.x;
        p.y = g.y;
        p.vx = p.vy = 0;
        p.angle = g.a;
        p.state = 'sit';
        const coffee = sim.world.furniture[g.ref + 3] === F_TABLE;
        const [a, b] = coffee ? COFFEE : SIT;
        p.timer = a + sim.rng.next() * (b - a);
        p.link = null;
      }
      return true;
    }
    const sp = g.kind === 'board' ? Math.max(2.2, p.speed * 1.5) : p.speed;
    p.move(dt, sim.world, ((g.x - p.x) / d) * sp, ((g.y - p.y) / d) * sp);
    // not getting any closer (someone sat down there first, a wall between): never mind
    if (d < p.bestD - 0.1) (p.bestD = d), (p.timer = 0);
    else if ((p.timer += dt) > 2.5) {
      p.goal = null;
      p.bestD = Infinity;
      p.timer = 0;
      p.restless = sim.time + 20;
    }
    return true;
  }

  /** nobody but `p` within reach of (x, y) */
  private onlyMeAt(p: Ped, x: number, y: number) {
    let only = true;
    this.sim.forPedsNear(x, y, 1, (q) => {
      if (q !== p && !q.dead && !q.vehicle && Math.abs(q.x - x) < 0.4 && Math.abs(q.y - y) < 0.4) only = false;
    });
    return only;
  }

  private sitting(p: Ped, dt: number): boolean {
    const sim = this.sim;
    p.vx = p.vy = 0;
    if ((p.timer -= dt) > 0) return true;
    // up and off again (a step forward, off the seat)
    p.state = 'walk';
    p.link = null;
    p.restless = sim.time + 45 + sim.rng.next() * 45;
    this.push(p, Math.cos(p.angle) * 0.5, Math.sin(p.angle) * 0.5);
    if (sim.rng.chance(0.08)) this.say(p, SAY_CHAT);
    return true;
  }

  /** People sitting on the benches, in the shelters and at the café tables in the spawn ring
   *  around (x, y) (out of everyone's sight): how many sat down. */
  spawnSeated(x: number, y: number, rMin: number, rMax: number): number {
    const sim = this.sim, w = sim.world;
    const cands: number[] = [];
    w.forFurnitureNear(x, y, rMax, (i) => {
      const f = w.furniture;
      if (!SEATS[f[i + 3]] || !this.seatsOf(i).length) return;
      const d = dist(x, y, f[i], f[i + 1]);
      if (d >= rMin && d <= rMax && !sim.visibleToAny(f[i], f[i + 1], 4)) cands.push(i);
    });
    if (!cands.length) return 0;
    const i = sim.rng.pick(cands);
    const s = this.seatsOf(i);
    // a table of friends, a couple on a bench, someone alone in a shelter
    const want = w.furniture[i + 3] === F_TABLE ? 1 + sim.rng.int(3) : 1 + sim.rng.int(2);
    let n = 0;
    for (let k = sim.rng.int(s.length / 3) * 3, tries = 0; tries < s.length / 3 && n < want; tries++, k = (k + 3) % s.length) {
      if (!this.seatFree(s[k], s[k + 1]) || w.inWater(s[k], s[k + 1], 0)) continue;
      const p = new Ped('civ', s[k], s[k + 1], sim.rng.seed());
      p.angle = s[k + 2];
      p.state = 'sit';
      const coffee = w.furniture[i + 3] === F_TABLE;
      const [a, b] = coffee ? COFFEE : SIT;
      p.timer = a + sim.rng.next() * (b - a);
      p.restless = sim.time + 60;
      sim.addPed(p);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------- tram stops
  /** the direction of the track at tram stop `i` (index into World.tramStops, a multiple of 2) */
  private trackDir(i: number): number {
    const S = this.sim.world.tramStops;
    if (!this.stopDir) {
      const g = this.sim.world.tram, dir = new Float32Array(S.length / 2);
      for (let k = 0; k < S.length; k += 2) {
        let best = Infinity, a = 0;
        for (const e of g.edges)
          for (let j = 0; j < e.p.length - 2; j += 2) {
            const ax = e.p[j], ay = e.p[j + 1], dx = e.p[j + 2] - ax, dy = e.p[j + 3] - ay, L2 = dx * dx + dy * dy;
            if (L2 < 1e-6) continue;
            const t = Math.max(0, Math.min(1, ((S[k] - ax) * dx + (S[k + 1] - ay) * dy) / L2));
            const d = Math.hypot(ax + dx * t - S[k], ay + dy * t - S[k + 1]);
            if (d < best) (best = d), (a = Math.atan2(dy, dx));
          }
        dir[k / 2] = a;
      }
      this.stopDir = dir;
    }
    return this.stopDir[i / 2];
  }

  /** a spot to wait on the platform of stop `i`, on the side `side` (±1) of the track (or the
   *  other, when there's no room there): x, y and facing the track; null when neither has room */
  private platformSpot(i: number, side: number): { x: number; y: number; a: number } | null {
    const sim = this.sim, w = sim.world, S = w.tramStops;
    const a = this.trackDir(i), ux = Math.cos(a), uy = Math.sin(a);
    const along = (sim.rng.next() - 0.5) * 18, off = 2.3 + sim.rng.next() * 1.1;
    for (const s of [side, -side]) {
      const x = S[i] + ux * along - uy * off * s, y = S[i + 1] + uy * along + ux * off * s;
      if (w.collideCircle(x, y, 0.45, 0) || w.inWater(x, y, 0) || w.insideBuilding(x, y)) continue;
      return { x, y, a: Math.atan2(-ux * s, uy * s) };
    }
    return null;
  }

  private waitingAt(i: number) {
    const S = this.sim.world.tramStops;
    let n = 0;
    this.sim.forPedsNear(S[i], S[i + 1], 14, (q) => {
      if (!q.dead && (q.waitStop === i || (q.goal && q.goal.kind !== 'seat' && q.goal.ref === i))) n++;
    });
    return n;
  }

  /** someone walking near a tram stop may stop there to wait for a tram */
  private findTramStop(p: Ped) {
    const S = this.sim.world.tramStops;
    for (let i = 0; i < S.length; i += 2) {
      const dx = p.x - S[i], dy = p.y - S[i + 1];
      if (dx * dx + dy * dy > 22 * 22 || this.waitingAt(i) >= MAX_WAITING) continue;
      const a = this.trackDir(i);
      const spot = this.platformSpot(i, -dx * Math.sin(a) + dy * Math.cos(a) >= 0 ? 1 : -1);
      if (spot && this.sim.world.raycast(p.x, p.y, spot.x, spot.y, p.level) >= 1) this.setGoal(p, { ...spot, kind: 'stop', ref: i });
      return;
    }
  }

  /** stand at stop `i` (facing `a`) for the next tram */
  private wait(p: Ped, i: number, a = p.angle) {
    p.state = 'idle';
    p.waitStop = i;
    p.timer = 40 + this.sim.rng.next() * 80;
    p.angle = a;
    p.vx = p.vy = 0;
    p.link = null;
  }

  private waiting(p: Ped, dt: number): boolean {
    p.vx = p.vy = 0;
    if ((p.timer -= dt) > 0) return true;
    // gave up on it: walk
    p.waitStop = -1;
    p.state = 'walk';
    p.link = null;
    p.restless = this.sim.time + 60;
    return true;
  }

  /** People already waiting at a tram stop in the spawn ring around (x, y): how many. */
  spawnWaiting(x: number, y: number, rMin: number, rMax: number): number {
    const sim = this.sim, S = sim.world.tramStops;
    const cands: number[] = [];
    for (let i = 0; i < S.length; i += 2) {
      const d = dist(x, y, S[i], S[i + 1]);
      if (d >= rMin && d <= rMax && !sim.visibleToAny(S[i], S[i + 1], 12)) cands.push(i);
    }
    if (!cands.length) return 0;
    const i = sim.rng.pick(cands);
    let n = 0;
    const side = sim.rng.chance(0.5) ? 1 : -1;
    for (let k = 1 + sim.rng.int(3); k > 0 && this.waitingAt(i) < MAX_WAITING; k--) {
      const spot = this.platformSpot(i, side);
      if (!spot) break;
      const p = new Ped('civ', spot.x, spot.y, sim.rng.seed());
      this.wait(p, i, spot.a);
      sim.addPed(p);
      n++;
    }
    return n;
  }

  /** a tram standing at stop `i` with its doors open */
  private tramAt(i: number): Tram | null {
    const S = this.sim.world.tramStops;
    for (const t of this.sim.trams) if (t.dwell > 0.3 && Math.abs(t.x - S[i]) < 4 && Math.abs(t.y - S[i + 1]) < 4) return t;
    return null;
  }

  /** the door of tram `t` nearest (x, y), a step outside it on that side */
  private door(t: Tram, x: number, y: number) {
    let bx = t.x, by = t.y, bd = Infinity;
    for (const s of t.sections) {
      const ux = Math.cos(s.a), uy = Math.sin(s.a);
      const side = -(x - s.x) * uy + (y - s.y) * ux >= 0 ? 1 : -1;
      for (const o of [-2.8, 2.8]) {
        const dx = s.x + ux * o - uy * 1.9 * side, dy = s.y + uy * o + ux * 1.9 * side;
        const d = dist(x, y, dx, dy);
        if (d < bd) (bd = d), (bx = dx), (by = dy);
      }
    }
    return { x: bx, y: by };
  }

  /** Trams at their stops: people get off (a few, when someone's around to see it) and the ones
   *  waiting make for the doors. */
  private trams() {
    const sim = this.sim, S = sim.world.tramStops;
    for (const t of sim.trams) {
      if (t.dwell <= 0.3) {
        this.dwelling.delete(t);
        continue;
      }
      let stop = -1;
      for (let i = 0; i < S.length && stop < 0; i += 2) if (Math.abs(t.x - S[i]) < 4 && Math.abs(t.y - S[i + 1]) < 4) stop = i;
      if (stop < 0) continue;
      if (!this.dwelling.has(t)) {
        this.dwelling.add(t);
        this.alight(t);
      }
      sim.forPedsNear(t.x, t.y, 40, (q) => {
        if (q.waitStop !== stop || q.dead || q.vehicle || q.goal || q.state !== 'idle' || q.surrender > 0) return;
        const d = this.door(t, q.x, q.y);
        q.waitStop = -1;
        this.setGoal(q, { x: d.x, y: d.y, a: 0, kind: 'board', ref: stop });
      });
    }
  }

  /** up to two people step off tram `t` onto the platform and walk away */
  private alight(t: Tram) {
    const sim = this.sim, w = sim.world;
    if (sim.nearestCamera(t.x, t.y, 160) === Infinity) return;
    let civs = 0;
    for (const p of sim.peds) if (p.kind === 'civ') civs++;
    if (civs >= sim.caps.peds) return;
    for (let n = sim.rng.int(3); n > 0; n--) {
      const s = sim.rng.pick(t.sections), ux = Math.cos(s.a), uy = Math.sin(s.a);
      const o = sim.rng.chance(0.5) ? -2.8 : 2.8;
      for (const side of sim.rng.chance(0.5) ? [1, -1] : [-1, 1]) {
        const x = s.x + ux * o - uy * 2 * side, y = s.y + uy * o + ux * 2 * side;
        if (w.collideCircle(x, y, 0.45, t.level) || w.inWater(x, y, t.level) || w.insideBuilding(x, y)) continue;
        const p = new Ped('civ', x, y, sim.rng.seed());
        // facing away from the tram
        p.angle = Math.atan2(ux * side, -uy * side);
        p.restless = sim.time + 40;
        p.level = t.level;
        sim.addPed(p);
        break;
      }
    }
  }

  // --------------------------------------------------------------- fighting
  /** `p` goes for player `pl`, who punched them or shoved them: true when they do (the odd
   *  able-bodied one who isn't hurt too badly already), else they'll run like everybody else. */
  provoke(p: Ped, pl: SimPlayer): boolean {
    const sim = this.sim;
    if (!p.fighter || p.health < 45 || p.dead || p.vehicle || pl.state !== 'play') return false;
    this.hangUp(p);
    p.goal = null;
    p.waitStop = -1;
    p.handsUp = false;
    p.surrender = 0;
    p.state = 'fight';
    p.targetPid = pl.id;
    p.timer = 10 + sim.rng.next() * 6;
    if (sim.time - p.saidAt > 2) this.say(p, SAY_FIGHT);
    return true;
  }

  private fighting(p: Ped, dt: number): boolean {
    const sim = this.sim;
    const pl = sim.players.get(p.targetPid);
    if (p.cooldown > 0) p.cooldown -= dt;
    p.timer -= dt;
    const t = pl?.ped;
    const d = t ? dist(p.x, p.y, t.vehicle?.x ?? t.x, t.vehicle?.y ?? t.y) : Infinity;
    if (!pl || !t || pl.state !== 'play' || p.timer <= 0 || d > 25) {
      // cooled down (or lost them)
      p.state = 'walk';
      p.targetPid = 0;
      p.link = null;
      return true;
    }
    if (p.health < 40) {
      // had enough
      p.targetPid = 0;
      sim.combat.scare(p, t.x, t.y);
      return true;
    }
    // they got in a car: shout after it, then let it go
    if (t.vehicle) p.timer = Math.min(p.timer, 2);
    const tx = t.vehicle?.x ?? t.x, ty = t.vehicle?.y ?? t.y;
    const a = Math.atan2(ty - p.y, tx - p.x);
    if (d > 1.2) {
      p.move(dt, sim.world, Math.cos(a) * 3.6, Math.sin(a) * 3.6);
      return true;
    }
    p.move(dt, sim.world, 0, 0);
    p.angle = a;
    if (p.cooldown <= 0 && !t.vehicle) {
      p.cooldown = 0.75 + sim.rng.next() * 0.55;
      sim.combat.fireNpc(p, a, 'fist');
    }
    return true;
  }

  /** a civilian got hurt by `pl` (or by nobody in particular): they drop any call and either go
   *  for them (a punch, from the odd one) or run */
  hurt(p: Ped, pl: SimPlayer | null, by: { x: number; y: number }, melee: boolean) {
    this.hangUp(p);
    p.goal = null;
    p.waitStop = -1;
    if (p.state === 'sit') p.state = 'walk';
    if (melee && pl && (p.state === 'fight' ? p.health >= 40 && ((p.targetPid = pl.id), true) : this.provoke(p, pl))) return;
    p.targetPid = 0;
    this.sim.combat.scare(p, by.x, by.y);
  }

  // -------------------------------------------------------------- witnesses
  /** A crime with no police around: someone who saw it gets away and phones them (the victim
   *  first, else a bystander with a clear view), which the player sees coming and can stop. */
  witness(pl: SimPlayer, x: number, y: number, victim: Ped | null) {
    const sim = this.sim;
    if (pl.wanted > 0 || pl.state !== 'play' || this.calls.has(pl.id)) return;
    let w: Ped | null = victim && !victim.dead && !victim.vehicle && victim.state !== 'fight' ? victim : null;
    if (!w) {
      let best = Infinity;
      sim.forPedsNear(x, y, 35, (q) => {
        if (q.kind !== 'civ' || q.dead || q.vehicle || q.callPid || q.state === 'fight' || q.surrender > 0) return;
        // not right next to it (they'd be too shaken), within sight
        const d = dist(q.x, q.y, x, y);
        const score = Math.abs(d - 16);
        if (d < 5 || d > 35 || score >= best || sim.world.raycast(x, y, q.x, q.y, q.level) < 1) return;
        best = score;
        w = q;
      });
    }
    if (!w) return;
    const wit: Ped = w;
    wit.callPid = pl.id;
    this.calls.set(pl.id, wit);
    // they get away first, then dial
    if (wit.state !== 'flee') sim.combat.scare(wit, x, y);
    wit.timer = Math.min(wit.timer, 2 + sim.rng.next() * 1.5);
    sim.events.toPlayer(pl.id, { k: 'msg', title: '', text: 'Svedok ide volať políciu! Zastav ho.', time: 3, color: '#ffab40' });
  }

  private dial(p: Ped) {
    p.state = 'phone';
    p.timer = CALL;
    p.vx = p.vy = 0;
    p.link = null;
    this.say(p, SAY_PHONE);
  }

  private phoning(p: Ped, dt: number): boolean {
    const sim = this.sim;
    p.vx = p.vy = 0;
    if ((p.timer -= dt) > 0) return true;
    // got through: the police are on their way
    const pl = sim.players.get(p.callPid);
    this.calls.delete(p.callPid);
    p.callPid = 0;
    p.state = 'walk';
    p.link = null;
    if (pl && pl.state === 'play') sim.reported(pl);
    return true;
  }

  /** a witness on the phone hangs up (hurt, a gun pointed at them, off to fight) */
  private hangUp(p: Ped) {
    if (!p.callPid) return;
    const pl = this.sim.players.get(p.callPid);
    if (this.calls.get(p.callPid) === p) this.calls.delete(p.callPid);
    p.callPid = 0;
    if (p.state === 'phone') p.state = 'walk';
    if (pl) this.sim.events.toPlayer(pl.id, { k: 'msg', title: '', text: 'Svedok nedovolal.', time: 2, color: '#b2ff59' });
  }

  /** calls that ended some other way: the witness is gone (dead, out of the city) or the player is */
  private checkCalls() {
    const sim = this.sim;
    for (const [pid, w] of this.calls) {
      const pl = sim.players.get(pid);
      const on = w.callPid === pid && !w.dead && (w.state === 'flee' || w.state === 'phone') && sim.peds.includes(w);
      if (on && pl && pl.state === 'play') continue;
      this.calls.delete(pid);
      if (w.callPid === pid) w.callPid = 0;
      if (w.state === 'phone') w.state = 'walk';
      if (pl && w.dead) sim.events.toPlayer(pid, { k: 'msg', title: '', text: 'Svedok nedovolal.', time: 2, color: '#b2ff59' });
    }
  }
}
