// Vydrž do 95. minúty (docs/plans/minigames.md): car football on a parking lot, and a joke every Slovak
// gets. At EURO 2024 Slovakia beat Belgium 1:0, then led England until Bellingham's bicycle kick in
// the 95th minute (1:2 after extra time); in September 2025 they beat Germany 2:0 at Tehelné pole.
//
// The pitch is marked out on a lot near the player (footballPitch.ts): boards all round and a goal at
// each end. The ball is a vehicle of its own kind (Vehicle's `ball`), so the physics knocks it about
// and every client sees it like any NPC car; online the server simulates it, the players' cars (their
// own clients' business) being moving walls to it. When the lobby is over each player gets a car in
// their half (they get in themselves, F: online their client must have seen it first; whoever drives
// onto the pitch can keep their own), and the match kicks off once everyone's in. Alone it's one of two
// scenarios, in turn: "Vedieš 1:0" (90:00 to 95:00 against NPC England, who try a bicycle kick at the
// end: stand in its way) or "Nemecko 2:0" (score twice against NPC Germany). With others it's two
// teams by joining order, SVK and ENG, NPC cars making up a short one: two goals win, or the most at
// the whistle. A goal stops the clock; the kick-off puts the ball back on the centre spot and the NPC
// cars back on theirs.
import { LIVERY_DERBY, LIVERY_NONE, Vehicle, type Pen } from '../../../../entities/Vehicle';
import { clamp, dist, hypot } from '../../../../util/math';
import type { Crime, Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { placeName } from '../../placeName';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';
import { findPitch, PitchFrame } from './footballPitch';
import { drive, hold, makeBot, pickLeads, toSpot, type Bot, type Role } from './footballBots';

/** the match: this long (s of play; kick-offs and goals stop the clock) */
export const MATCH_S = 180;
/** getting to the pitch and into a car: a base, plus the way from the farthest player on foot (s) */
const WARM_BASE = 40, WARM_PER_M = 1 / 4.5, WARM_MAX = 240;
/** a kick-off's pause, and a goal's celebration before it (s) */
export const KICK_S = 3, GOAL_S = 3;
/** the round's safety net (s since it went live) */
const MAX_S = 720;
/** with others: this many goals win it */
export const GROUP_GOALS = 2;
/** the pay: alone, a win and a loss; with others, the winning team, the others, a draw; and a goal */
export const PAY_WIN = 250, PAY_LOSS = 60, PAY_TEAM_WIN = 200, PAY_TEAM_LOSS = 60, PAY_DRAW = 100, PAY_GOAL = 50;
/** the bicycle kick: it's on this long before the whistle (s of play, a range), from this close to the
 *  goal (m), after a wind-up (s), at this pace (m/s); it's blocked if it isn't in after NOZ_FLIGHT s */
const NOZ_BEFORE = [14, 22], NOZ_R = 26, NOZ_WIND = 1.2, NOZ_V = 21, NOZ_FLIGHT = 2;
/** the ball's radius (m) */
const BALL_R = 0.8;
/** after the whistle, the NPC cars give the players this long (s) to get going */
const KICK_GRACE = 1;
/** a car is touching the ball within this of its rim (m); a goal goes to the scoring team's last touch
 *  within CREDIT_S (s) */
const TOUCH = 0.35, CREDIT_S = 8;
/** a car on the pitch under this share of its health gets fixed at a kick-off */
const PIT_STOP = 0.6;
/** the crimes of a car football match: none of them counts on the pitch (a pedestrian who wanders
 *  onto it, a police car that drives in, a car that burns out) */
const PITCH_CRIMES: ReadonlySet<Crime> = new Set<Crime>(['killPed', 'hitCop', 'destroy', 'hitPlayer', 'killPlayer']);

interface Side {
  tag: string;
  color: string;
}
const SVK: Side = { tag: 'SVK', color: '#1565c0' };
const ENG: Side = { tag: 'ENG', color: '#f5f5f5' };
const GER: Side = { tag: 'GER', color: '#37474f' };

type Stage = 'warm' | 'kick' | 'play' | 'goal';
type Mode = 'eng' | 'ger' | 'group';
type Touch = { pid: number; t: number };

/** a car for the match: four wheels (the ball would throw a scooter's rider), dry land, and not a bus
 *  (parked across the goal it would be too easy) */
function fitForPitch(v: Vehicle | null): v is Vehicle {
  return !!v && !v.spec.twoWheeler && !v.spec.boat && !v.spec.ball && v.kind !== 'bus' && !v.wrecked;
}

class Football extends MiniGame {
  private f: PitchFrame;
  private place: string;
  private mode: Mode = 'eng';
  private sides: [Side, Side] = [SVK, ENG];
  private stage: Stage = 'warm';
  /** seconds left of the warm-up, the kick-off's pause or the goal's celebration */
  private stageT = 0;
  /** seconds of play so far, and since the round went live */
  private clock = 0;
  private total = 0;
  private score: [number, number] = [0, 0];
  private ball: Vehicle | null = null;
  private bots: Bot[] = [];
  /** each player's car for the match (spawned here: handed over at the end if they're in it) */
  private cars = new Map<number, Vehicle>();
  private team = new Map<number, 0 | 1>();
  /** each player's goals */
  private goals = new Map<number, number>();
  /** each team's last touch of the ball: the car's player (0: an NPC) and when */
  private touched: [Touch | null, Touch | null] = [null, null];
  /** the bicycle kick (England only): when it's on (s of play), and how far it's got */
  private noz = { at: MATCH_S, state: 'wait' as 'wait' | 'wind' | 'flight' | 'done', t: 0 };
  /** the goal being celebrated: the team that scored */
  private cheer: 0 | 1 = 0;
  private clearAcc = 0;
  /** seconds the NPC cars still wait after a kick-off's whistle */
  private grace = 0;

  constructor(sim: Sim, round: MiniRound, pitch: Pen) {
    super(sim, round);
    this.f = new PitchFrame(pitch);
    this.place = placeName(sim.world, pitch.x, pitch.y);
  }

  private get p() {
    return this.f.p;
  }

  teamOf(p: SimPlayer): 0 | 1 {
    return this.team.get(p.id) ?? 0;
  }

  // ------------------------------------------------------------------------------ setting up
  start() {
    const p = this.p;
    const solo = this.players.length < 2;
    this.mode = solo ? ((this.players[0].profile.stats?.mini_football ?? 0) % 2 ? 'ger' : 'eng') : 'group';
    this.sides = [SVK, this.mode === 'ger' ? GER : ENG];
    if (this.mode === 'eng') this.score = [1, 0];
    this.players.forEach((q, i) => this.team.set(q.id, (i % 2) as 0 | 1));
    this.clearPitch(true);
    this.putBall();
    this.spawnBots();
    for (const q of this.players) this.giveCar(q);
    // the warm-up: long enough to come on foot from the farthest player
    let far = 0;
    for (const q of this.players) {
      const at = q.focus();
      far = Math.max(far, dist(at.x, at.y, p.x, p.y));
    }
    this.stage = 'warm';
    this.stageT = clamp(WARM_BASE + far * WARM_PER_M, WARM_BASE, WARM_MAX);
    for (const q of this.players) this.msg(q, `Ihrisko je na parkovisku ${this.place}. Nasadni do auta a poď na ihrisko!`, '#ffd740', 3.5);
  }

  /** the ball on the centre spot (again, should anything have taken it out of the city) */
  private putBall() {
    const p = this.p;
    const b = this.spawnVehicle(new Vehicle('ball', p.x, p.y, p.a, '#fafafa'));
    b.pen = p;
    b.parked = false;
    b.level = 0;
    b.levelInit = true;
    this.ball = b;
  }

  /** The NPC footballers: alone, England (a keeper and two strikers) or Germany, who defend (a keeper
   *  and two defenders), one fewer on a small pitch; with others, as many as make the teams even. */
  private spawnBots() {
    const p = this.p;
    const small = p.hl < 20;
    const add = (team: 0 | 1, roles: Role[]) => {
      const dir = team === 0 ? 1 : -1;
      let n = 0;
      for (const role of roles) {
        const side = n++ % 2 ? 1 : -1;
        const [hx, hy] = role === 'gk' ? [-dir * (p.hl - 3), 0] : role === 'def' ? [-dir * p.hl * 0.5, side * p.hw * 0.25] : [-dir * p.hl * 0.35, side * p.hw * 0.3];
        const v = new Vehicle('sedan', this.f.wx(hx, hy), this.f.wy(hx, hy), p.a + (team === 0 ? 0 : Math.PI), this.sides[team].color);
        v.livery = LIVERY_DERBY;
        // nobody gets in: an NPC footballer isn't for taking
        v.locked = true;
        v.parked = false;
        v.level = 0;
        v.levelInit = true;
        this.spawnVehicle(v);
        this.bots.push(makeBot(v, team, role, hx, hy, side));
      }
    };
    if (this.mode === 'eng') add(1, small ? ['gk', 'att'] : ['gk', 'att', 'att']);
    else if (this.mode === 'ger') add(1, small ? ['gk', 'def'] : ['gk', 'def', 'def']);
    else {
      const n = [0, 0];
      for (const q of this.players) n[this.teamOf(q)]++;
      const short: 0 | 1 = n[0] < n[1] ? 0 : 1;
      add(short, (['att', 'def', 'att'] as Role[]).slice(0, Math.abs(n[0] - n[1])));
    }
  }

  /** A car for `q` in their half (unless they're already in one on the pitch), held for them: they get
   *  in themselves (F) — online their client simulates it, so it has to have seen it first. */
  private giveCar(q: SimPlayer) {
    const sim = this.sim, p = this.p;
    if (fitForPitch(q.ped.vehicle) && this.f.on(q.ped.vehicle.x, q.ped.vehicle.y, 4)) return;
    const t = this.teamOf(q), dir = t === 0 ? 1 : -1;
    const k = this.players.filter((o) => this.teamOf(o) === t).indexOf(q);
    const lx = -dir * p.hl * 0.55;
    const v = new Vehicle('hatch', 0, 0, p.a + (t === 0 ? 0 : Math.PI), this.sides[t].color);
    for (const off of [[0, -0.4, 0.4][k % 3], 0.2, -0.2, 0.6, -0.6]) {
      v.x = this.f.wx(lx, off * p.hw);
      v.y = this.f.wy(lx, off * p.hw);
      if (sim.clearFor(v)) break;
    }
    v.livery = LIVERY_DERBY;
    v.mission = true;
    v.parked = true;
    v.level = 0;
    v.levelInit = true;
    v.reservedFor = q.id;
    v.reservedUntil = sim.time + MAX_S + 60;
    sim.addVehicle(v);
    this.cars.set(q.id, v);
  }

  // ------------------------------------------------------------------------------ the step
  update(dt: number) {
    this.total += dt;
    if (this.total > MAX_S) return this.whistle();
    const sim = this.sim;
    if (!this.ball || !sim.vehicles.includes(this.ball)) this.putBall();
    this.clearAcc -= dt;
    if (this.clearAcc <= 0) {
      this.clearAcc = 1;
      this.clearPitch(false);
    }
    // an NPC footballer takes knocks, but never so many that it burns
    for (const b of this.bots) {
      b.v.health = Math.max(b.v.health, b.v.spec.health * 0.3);
      b.v.fire = -1;
    }
    switch (this.stage) {
      case 'warm':
        return this.warm(dt);
      case 'kick':
        return this.kick(dt);
      case 'play':
        return this.play(dt);
      case 'goal':
        for (const b of this.bots) hold(b);
        this.stageT -= dt;
        if (this.stageT <= 0) this.kickOff(false);
    }
  }

  /** is `q` ready to play: in a car fit for it, on the pitch */
  private ready(q: SimPlayer) {
    const v = q.ped.vehicle;
    return q.state === 'play' && fitForPitch(v) && this.f.on(v.x, v.y, 4);
  }

  private warm(dt: number) {
    this.stageT -= dt;
    for (const b of this.bots) hold(b);
    const ready = this.players.filter((q) => this.ready(q)).length;
    if (ready && ready === this.players.length) return this.kickOff(true);
    if (this.stageT > 0) return;
    if (ready) return this.kickOff(true);
    for (const q of this.players) this.outcome(q, { pay: 0, text: 'Na zápas si neprišiel – rozhodca zapísal kontumáciu.' });
    this.finish();
  }

  /** The kick-off (the first, or after a goal): the ball on the centre spot, held there a moment; the
   *  NPC cars on their spots; stray cars off the pitch; the players' cars fixed if they need it. */
  private kickOff(first: boolean) {
    const p = this.p, b = this.ball!;
    this.stage = 'kick';
    this.stageT = KICK_S;
    b.x = p.x;
    b.y = p.y;
    b.vx = b.vy = b.av = 0;
    b.kinematic = true;
    for (const bot of this.bots) {
      toSpot(bot, this.f);
      bot.v.health = bot.v.spec.health;
      bot.v.dmg.front = bot.v.dmg.rear = bot.v.dmg.left = bot.v.dmg.right = 0;
    }
    this.clearPitch(true);
    if (first) {
      // whoever came in a car of their own doesn't need the one waiting for them
      for (const [pid, v] of [...this.cars]) {
        const q = this.players.find((o) => o.id === pid);
        if (q && q.ped.vehicle && q.ped.vehicle !== v && this.ready(q)) this.dropCar(pid);
      }
      this.noz.at = MATCH_S - this.sim.rng.range(NOZ_BEFORE[0], NOZ_BEFORE[1]);
      const line =
        this.mode === 'eng' ? '90. minúta, vedieš 1:0 s Anglickom. Vydrž do 95.!' : this.mode === 'ger' ? 'Tehelné pole, kvalifikácia s Nemeckom. Daj im dva góly!' : '';
      for (const q of this.players) this.msg(q, line || `Hráš za ${this.sides[this.teamOf(q)].tag}. Dva góly vyhrávajú.`, '#ffd740', 3.5);
    } else this.pitStop();
  }

  private kick(dt: number) {
    const p = this.p, b = this.ball!;
    // (held: even a blast doesn't move it)
    b.x = p.x;
    b.y = p.y;
    b.vx = b.vy = 0;
    b.kinematic = true;
    for (const bot of this.bots) hold(bot);
    this.stageT -= dt;
    if (this.stageT > 0) return;
    this.stage = 'play';
    b.kinematic = false;
    this.touched = [null, null];
    this.grace = KICK_GRACE;
    this.tell('Výkop!', '#ffffff', 1.5);
  }

  private play(dt: number) {
    this.clock += dt;
    const b = this.ball!;
    // England throws everything forward in the last minute; Germany sits deep (and clears the ball
    // steadily, not flat out); with others, steady
    const press = this.mode === 'eng' ? clamp((this.clock - (MATCH_S - 60)) / 40, 0, 1) : this.mode === 'ger' ? 0.2 : 0.3;
    pickLeads(this.bots, b);
    this.grace -= dt;
    for (const bot of this.bots) this.grace > 0 ? hold(bot) : drive(this.sim, bot, this.f, b, { press, steady: this.mode === 'ger' }, dt);
    this.touches();
    this.bicycle(dt);
    const t = this.goalFor();
    if (t !== null) return this.scored(t);
    if (this.clock >= MATCH_S) this.whistle();
  }

  /** each team's car touching the ball now (a player's, or an NPC's; the nearest), for a goal's credit */
  private touches() {
    const b = this.ball!;
    const gap: [number, number] = [TOUCH, TOUCH], who: [number, number] = [-1, -1];
    const near = (v: Vehicle, team: 0 | 1, pid: number) => {
      if (Math.abs(v.x - b.x) > v.radius + 2 || Math.abs(v.y - b.y) > v.radius + 2) return;
      for (let i = 0; i < v.circles.length; i++) {
        const d = dist(v.circleX(i), v.circleY(i), b.x, b.y) - v.spec.width / 2 - BALL_R;
        if (d < gap[team]) (gap[team] = d), (who[team] = pid);
      }
    };
    for (const bot of this.bots) near(bot.v, bot.team, 0);
    for (const q of this.players) if (q.ped.vehicle) near(q.ped.vehicle, this.teamOf(q), q.id);
    for (const t of [0, 1] as const) if (who[t] >= 0) this.touched[t] = { pid: who[t], t: this.sim.time };
  }

  /** the team the ball has just gone in for (all of it over a goal line between the posts), or null */
  private goalFor(): 0 | 1 | null {
    const b = this.ball!, p = this.p;
    const lx = this.f.lx(b.x, b.y), ly = this.f.ly(b.x, b.y);
    if (Math.abs(ly) >= p.gw / 2 || Math.abs(lx) < p.hl + BALL_R) return null;
    // over the +x line it's in the away team's goal: a goal for home
    return lx > 0 ? 0 : 1;
  }

  /** England's bicycle kick (the 95th minute): once it's on and the ball is in range of our goal, a
   *  wind-up everyone's warned of, then the ball flies at the goal. A car in the way stops it. */
  private bicycle(dt: number) {
    if (this.mode !== 'eng') return;
    const n = this.noz, p = this.p, b = this.ball!;
    const lx = this.f.lx(b.x, b.y), ly = this.f.ly(b.x, b.y);
    switch (n.state) {
      case 'wait':
        if (this.clock < n.at || dist(lx, ly, -p.hl, 0) > NOZ_R || lx < -p.hl + 3 || Math.abs(ly) > p.hw * 0.75) return;
        n.state = 'wind';
        n.t = NOZ_WIND;
        this.tell('Bellingham sa rozbieha na nožničky! Postav sa do cesty!', '#ff5252', 2.5);
        return;
      case 'wind': {
        n.t -= dt;
        if (n.t > 0) return;
        // at a spot inside the mouth (clear of the posts), from wherever the ball is now
        const ty = this.sim.rng.range(-p.gw / 2 + 1.3, p.gw / 2 - 1.3);
        const ux = -p.hl - 1 - lx, uy = ty - ly, ul = hypot(ux, uy) || 1;
        const vl = (ux / ul) * NOZ_V, vw = (uy / ul) * NOZ_V;
        b.vx = vl * this.f.ca - vw * this.f.sa;
        b.vy = vl * this.f.sa + vw * this.f.ca;
        b.air = 0.8;
        this.touched[1] = { pid: 0, t: this.sim.time };
        for (const q of this.players) this.pop(q, 'NOŽNIČKA!', b.x, b.y - 2);
        n.state = 'flight';
        n.t = NOZ_FLIGHT;
        return;
      }
      case 'flight':
        n.t -= dt;
        if (n.t > 0) return;
        n.state = 'done';
        this.tell('Zablokované! Celé Slovensko dýcha.', '#69f0ae', 3);
    }
  }

  /** A goal for team `t`: the scoreline, who scored it, and whether that decides it. It's the scoring
   *  team's last touch's (a deflection off the other team doesn't take it away); an own goal if only
   *  the other team touched it. */
  private scored(t: 0 | 1) {
    const sim = this.sim;
    this.score[t]++;
    const fresh = (k: 0 | 1) => {
      const c = this.touched[k];
      return c && sim.time - c.t < CREDIT_S ? c : null;
    };
    const tc = fresh(t);
    const own = !tc && !!fresh(t === 0 ? 1 : 0);
    const scorer = tc && tc.pid ? this.players.find((q) => q.id === tc.pid) : undefined;
    if (scorer) this.goals.set(scorer.id, (this.goals.get(scorer.id) ?? 0) + 1);
    if (this.noz.state === 'flight' || this.noz.state === 'wind') this.noz.state = 'done';
    const [a, b] = this.score;
    const line = `${this.sides[0].tag} ${a}:${b} ${this.sides[1].tag}`;
    const ball = this.ball!;
    for (const q of this.players) {
      const ours = this.teamOf(q) === t;
      const who = scorer === q ? 'Dal si ho!' : scorer ? `${scorer.nick}!` : own ? 'Vlastný gól!' : '';
      this.msg(q, ours ? `GÓÓÓL! ${who} ${line}` : `Gól… ${line}`, ours ? '#69f0ae' : '#ff8a80', 3);
      this.pop(q, ours ? 'GÓÓÓL!' : 'gól…', ball.x, ball.y - 2);
    }
    // decided: England level (it was 1:0), two goals past Germany (and ahead), a team with two goals
    if ((this.mode === 'eng' && t === 1 && b >= a) || (this.mode === 'ger' && this.gerNeed() === 0) || (this.mode === 'group' && this.score[t] >= GROUP_GOALS)) return this.settle();
    this.stage = 'goal';
    this.stageT = GOAL_S;
    this.cheer = t;
  }

  /** against Germany: the goals still to score (two in all, and more than Germany's) */
  private gerNeed() {
    const [a, b] = this.score;
    return Math.max(0, 2 - a, b - a + 1);
  }

  private gerLine() {
    const n = this.gerNeed();
    if (n === 1) return 'Ešte jeden gól – a je to doma!';
    if (!this.score[0] && !this.score[1]) return 'Daj Nemcom dva góly!';
    return `Ešte ${n <= 4 ? `${['dva', 'tri', 'štyri'][n - 2]} góly` : `${n} gólov`}!`;
  }

  /** the time's up (or the safety net's reached) */
  private whistle() {
    if (!this.over) this.settle();
  }

  /** Everyone's result: the money, a line, and the standings (a win, then the goals). */
  private settle() {
    const [a, b] = this.score;
    for (const q of this.players) {
      const t = this.teamOf(q);
      const us = t === 0 ? a : b, them = t === 0 ? b : a;
      const g = this.goals.get(q.id) ?? 0;
      let pay: number, text: string;
      if (this.mode === 'eng') {
        const won = a > b;
        pay = won ? PAY_WIN : PAY_LOSS;
        text = won ? `Slovensko je vo štvrťfinále! ${a}:${b}` : `Bellingham v 95. minúte… ${a}:${b}, a predĺženie už nevydržíte.`;
      } else if (this.mode === 'ger') {
        const won = this.gerNeed() === 0;
        pay = won ? PAY_WIN : PAY_LOSS;
        text = won ? `${a}:${b} s Nemeckom! Tehelné pole šalie.` : a > b ? `Len ${a}:${b} – na dva góly to nestačilo.` : `${a}:${b}. Nemecký betón vydržal.`;
      } else {
        pay = us > them ? PAY_TEAM_WIN : us < them ? PAY_TEAM_LOSS : PAY_DRAW;
        text = us > them ? `Vyhrali ste ${us}:${them}!` : us < them ? `Prehrali ste ${us}:${them}.` : `Remíza ${us}:${them}.`;
      }
      this.outcome(q, { pay: pay + PAY_GOAL * g, text: g ? `${text} (${g === 1 ? 'tvoj gól' : `tvoje góly: ${g}`})` : text });
      this.addPoints(q, (us > them ? 1000 : us === them ? 500 : 0) + g * 10);
    }
    this.finish();
  }

  finish() {
    super.finish();
    // the result stays on screen a while: the NPC cars stand, the ball rolls out
    for (const b of this.bots) hold(b);
    if (this.ball) this.ball.kinematic = false;
  }

  // ------------------------------------------------------------------------------ the pitch
  /** Cars that don't belong on the pitch go: parked, abandoned or burnt out, nobody's (the city's
   *  parked cars come back to a lot all the time). Only unseen ones while the match is on, unless
   *  `seen` (a kick-off: the pitch is cleared for it). A scooter or a bike at a dock stays: the ball
   *  and the cars just knock it aside. */
  private clearPitch(seen: boolean) {
    const sim = this.sim;
    const ours = new Set<Vehicle>([...this.bots.map((b) => b.v), ...this.cars.values()]);
    if (this.ball) ours.add(this.ball);
    const kept = new Set<Vehicle>();
    for (const q of sim.players.values()) if (q.lastCar) kept.add(q.lastCar);
    const gone = sim.vehicles.filter(
      (v) =>
        !ours.has(v) && !kept.has(v) && !v.owner && !v.kinematic && !v.mission && !v.driver && !v.spec.twoWheeler && v.speed < 0.5 &&
        !(v.reservedFor && sim.time < v.reservedUntil) && this.f.on(v.x, v.y, 1) && (seen || !sim.visibleToAny(v.x, v.y, 6)),
    );
    for (const v of gone) sim.removeVehicle(v);
  }

  /** At a kick-off after a goal the mechanics see to any car on the pitch that took a beating (a
   *  player's car online is their client's: the `spray` event tells it, as the workshop's does). */
  private pitStop() {
    for (const q of this.players) {
      const v = q.ped.vehicle;
      if (!v || !this.ready(q) || v.health >= v.spec.health * PIT_STOP) continue;
      if (v.kinematic) this.sim.events.toPlayer(q.id, { k: 'spray', vehicle: v.id, color: v.color });
      else {
        v.health = v.spec.health;
        v.fire = -1;
        v.dmg.front = v.dmg.rear = v.dmg.left = v.dmg.right = 0;
      }
      this.msg(q, 'Mechanici ti cez prestávku opravili auto.', '#90caf9', 2.5);
    }
  }

  /** A player's car for the match goes: out of the city, unless someone's in it (then it's theirs,
   *  an ordinary car again). */
  private dropCar(pid: number) {
    const v = this.cars.get(pid);
    this.cars.delete(pid);
    if (!v) return;
    const sim = this.sim;
    const driven = [...sim.players.values()].some((q) => q.ped.vehicle === v);
    if (driven) {
      v.mission = false;
      v.livery = LIVERY_NONE;
      v.reservedFor = 0;
      v.rev++;
    } else if (sim.vehicles.includes(v)) sim.removeVehicle(v);
  }

  onLeave(p: SimPlayer) {
    this.dropCar(p.id);
    // with others: a team with nobody left in it has walked off
    if (this.mode !== 'group' || this.over) return;
    const left = [0, 0];
    for (const q of this.players) if (q !== p) left[this.teamOf(q)]++;
    if (left[0] && left[1]) return;
    for (const q of this.players) {
      if (q === p) continue;
      this.outcome(q, { pay: PAY_TEAM_WIN, text: 'Súper ušiel z ihriska – kontumačne 3:0.' });
      this.addPoints(q, 1000);
    }
    this.finish();
  }

  /** no stars for what a car football match does to whoever wanders onto the pitch */
  allowCrime(p: SimPlayer, kind: Crime) {
    if (!this.has(p) || this.over || !PITCH_CRIMES.has(kind)) return true;
    const at = p.focus();
    return !this.f.on(at.x, at.y, 8);
  }

  dispose() {
    for (const pid of [...this.cars.keys()]) this.dropCar(pid);
    super.dispose();
  }

  // ------------------------------------------------------------------------------ the view
  /** the match clock: 90:00 to 95:00 against England, 0' to 90' against Germany, 0:00 to 3:00 with
   *  others */
  private clockText() {
    const k = this.clock / MATCH_S;
    if (this.mode === 'ger') return `${Math.floor(k * 90)}'`;
    const s = Math.floor(this.mode === 'eng' ? 90 * 60 + k * 300 : this.clock);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** what the drawers need: the pitch, the ball, the teams, the score and the clock */
  private xs(p: SimPlayer): Record<string, number | string | number[]> {
    const q = this.p;
    return {
      p: [q.x, q.y, q.a, q.hl, q.hw, q.gw, q.gd],
      b: this.ball?.id ?? 0,
      ta: this.sides[0].tag,
      tb: this.sides[1].tag,
      ca: this.sides[0].color,
      cb: this.sides[1].color,
      sa: this.score[0],
      sb: this.score[1],
      me: this.teamOf(p),
      clk: this.clockText(),
      st: this.stage,
      noz: this.noz.state === 'wind' ? 1 : 0,
      gl: this.stage === 'goal' ? this.cheer + 1 : 0,
    };
  }

  /** the two goals (the map has them from the drawer); `mine`: say which is whose */
  private goalMarks(p: SimPlayer, mine = true): MiniMark[] {
    const q = this.p, t = this.teamOf(p);
    return ([-1, 1] as const).map((s) => {
      const keeper = s < 0 ? 0 : 1;
      const x = this.f.wx(s * (q.hl + q.gd / 2), 0), y = this.f.wy(s * (q.hl + q.gd / 2), 0);
      const label = !mine ? 'bránka' : keeper === t ? 'tvoja bránka' : 'súperova bránka';
      return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w: q.gd, h: q.gw, a: q.a, color: this.sides[keeper].color, label, noMap: 1 };
    });
  }

  view(p: SimPlayer): MiniView {
    const marks = this.goalMarks(p);
    const t = this.teamOf(p);
    const ready = this.ready(p);
    const car = this.cars.get(p.id);
    const b = this.ball;
    if (this.stage === 'warm' && !ready && car && this.sim.vehicles.includes(car))
      marks.push({ x: Math.round(car.x), y: Math.round(car.y), e: car.id, icon: '🚗', label: 'tvoje auto', color: this.sides[t].color, r: 3, arrow: 1 });
    else if (b) marks.push({ x: Math.round(b.x), y: Math.round(b.y), e: b.id, color: '#ffffff', arrow: 1 });
    return { goal: this.goalLine(p, ready), marks, x: this.xs(p) };
  }

  private goalLine(p: SimPlayer, ready: boolean): string {
    const [a, b] = this.score, t = this.teamOf(p);
    switch (this.stage) {
      case 'warm': {
        if (ready) return `Čaká sa na ostatných (${this.players.filter((q) => this.ready(q)).length}/${this.players.length})…`;
        const v = p.ped.vehicle;
        if (v && this.f.on(v.x, v.y, 4))
          return v.kind === 'bus' ? 'Zaparkovať autobus pred bránku? To by bolo príliš ľahké – prezleč sa do auta.' : 'Na tomto sa futbal nehrá – nasadni do auta (F).';
        const at = p.focus();
        const d = Math.round(dist(at.x, at.y, this.p.x, this.p.y));
        return d > 70 ? `Zápas na parkovisku ${this.place} – príď tam (${d} m) a nasadni do auta.` : 'Nasadni do auta na ihrisku (F).';
      }
      case 'kick':
        return this.mode === 'eng' ? `Vedieš ${a}:${b} – vydrž do 95. minúty!` : this.mode === 'ger' ? this.gerLine() : `Hráš za ${this.sides[t].tag}. Výkop!`;
      case 'goal':
        return this.cheer === t ? 'GÓÓÓL!' : 'Gól… Hlavu hore, hrá sa ďalej.';
      default:
        if (this.mode === 'eng') {
          if (this.noz.state === 'wind') return 'NOŽNIČKA! Postav sa lopte do cesty!';
          return a - b >= 2 ? `Vedieš ${a}:${b} – dotiahni to!` : 'Ubráň 1:0 do 95. minúty – lopta nesmie do tvojej bránky!';
        }
        if (this.mode === 'ger') return this.gerLine();
        return `Daj gól do súperovej bránky – ${GROUP_GOALS} vyhrávajú.`;
    }
  }

  lobbyView(p: SimPlayer): MiniView {
    const at = p.focus();
    const d = Math.round(dist(at.x, at.y, this.p.x, this.p.y));
    // (the teams and the scenario are settled when the lobby's over: here, just the pitch)
    const q = this.p;
    return {
      goal: d > 70 ? `Futbal na parkovisku ${this.place} – vyraz tam (${d} m).` : `Futbal na parkovisku ${this.place} – o chvíľu výkop.`,
      marks: [...this.goalMarks(p, false), { x: q.x, y: q.y, icon: '⚽', label: 'ihrisko', arrow: 1 }],
      x: { p: [q.x, q.y, q.a, q.hl, q.hw, q.gw, q.gd] },
    };
  }

  /** with others: the teams' score, not the players' points */
  board(): [string, number][] | undefined {
    if (this.mode !== 'group') return undefined;
    const rows: [string, number][] = [[this.sides[0].tag, this.score[0]], [this.sides[1].tag, this.score[1]]];
    return rows.sort((x, y) => y[1] - x[1]);
  }
}

export const FOOTBALL_DEF: MiniGameDef = {
  kind: 'football',
  lobby: 20,
  create(sim, round) {
    const at = round.owner.focus();
    const found = findPitch(sim.world, at.x, at.y);
    if (!found) return 'Široko-ďaleko tu nie je parkovisko, kde by sa dalo hrať – skús pri Auparku alebo pri Eurovei.';
    // the round is where its pitch is (who can join it, the map's marker)
    round.x = found.pitch.x;
    round.y = found.pitch.y;
    return new Football(sim, round, found.pitch);
  },
};
