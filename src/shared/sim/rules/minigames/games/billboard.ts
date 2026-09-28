// Bilbordová vojna (docs/plans/minigames.md): every election since 2022 (the municipal one in 2022,
// the parliament in 2023, the president and Brussels in 2024, and now the mayor on 24 October 2026)
// fills Bratislava with the same smiling faces, and somebody always draws a moustache on them. Two
// fictional candidates (nobody real, roasted equally) fight over the billboards and bus shelters
// around the player: paste your poster on a spot (the action key, a few seconds standing still),
// draw a moustache on the rival's (the action key again: then it can be pasted over), pick up
// the campaign's promises lying about the city, and stop pasting when the campaign silence starts
// (the last 48 s: whoever pastes then pays a fine and gets a police star). The spots held at the end
// are the election result.
//
// Alone it's against an AI campaign that flips a spot every few seconds somewhere, far from the
// player where it can; with others it's two campaigns (the teams by the order they joined, red and
// blue), and a campaign whose players have all gone is taken over by the AI.
import { dist } from '../../../../util/math';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';

/** The two candidates (made up, and equally ridiculous): who a campaign pastes, the genitive for
 *  "posters of…", their slogan. Which team gets which is drawn for every round. */
export const CANDIDATES = [
  { name: 'Ing. Jožko Sľubný', gen: 'Ing. Jožka Sľubného', short: 'Sľubný', slogan: 'Nový most do roka!' },
  { name: 'Mgr. Zuzka Cyklopruhová', gen: 'Mgr. Zuzky Cyklopruhovej', short: 'Cyklopruhová', slogan: 'Viac zelene, menej áut!' },
] as const;
/** the campaigns' colours: the first to join is red, the second blue, and so on in turn */
export const TEAM_COLORS = ['#ef5350', '#42a5f5'] as const;
const NEUTRAL = '#cfd8dc';

/** furniture kinds (FURNITURE in world/Street.ts) a poster goes on: a bus shelter, a billboard, an
 *  advertising column */
const F_SHELTER = 4, F_BILLBOARD = 5, F_COLUMN = 6;
/** the spots: the nearest this many within SPOT_R of the start (m); fewer than SPOT_MIN there and it
 *  looks as far as SPOT_FAR; fewer than SPOT_NONE at all and there's no campaign to be had here */
const SPOT_MAX = 24, SPOT_R = 700, SPOT_MIN = 12, SPOT_FAR = 1100, SPOT_NONE = 6;
/** two spots closer than this (m) are one (a shelter mapped twice) */
const SPOT_SAME = 8;
/** a spot is only one someone can walk up to: a walkable path this close to it (m) */
const SPOT_PATH = 16;
/** the action key reaches a spot from this far (m) */
const REACH = 4.5;
/** pasting a poster, and drawing a moustache, takes this long standing still (s); a promise of the
 *  tram makes the next two pastes this quick */
const PASTE_S = 3, DEFACE_S = 1.5, FAST_S = 0.8;
/** standing still: no further than this from where it began (m), no faster than this (m/s) */
const STILL_R = 1.2, STILL_V = 1.5;
/** the round (s), and its last part: the campaign silence (Slovakia's lasts 48 hours before the
 *  polls open; here, 48 seconds) */
const ROUND_S = 240, SILENCE_S = 48;
/** pasting during the silence: this fine (€) and a police star */
const SILENCE_FINE = 50;
/** The AI campaign's next move, every so often (s): a paste or a moustache; in the silence it only
 *  draws moustaches, a little slower; and never within AI_KEEP_OFF (m) of a rival player. Its pace
 *  goes with the score: slower by a share AI_LEAD[2] for every spot it leads by, quicker for every
 *  spot behind, between AI_LEAD[0] and AI_LEAD[1] times. The spots are a hundred metres and more
 *  apart, so a player gets through one every 15 s or so by car and 25 s running: at a move every
 *  6–10 s the AI won every round (0:9 in the Old Town); at this pace a runner draws in Petržalka and
 *  on Nivy, a driver wins there, and the Old Town's scattered shelters take cunning (the promises,
 *  the moustaches in the silence). */
const AI_EVERY: [number, number] = [12, 16], AI_SILENCE: [number, number] = [14, 18], AI_KEEP_OFF = 25;
const AI_LEAD: [number, number, number] = [0.8, 2, 0.1];
/** promises on the map at a time, picked up from this far (m), the next one after a while (s) */
const PROMISES = 3, PROMISE_REACH = 3.5, PROMISE_NEXT: [number, number] = [15, 25];
/** pay: the winners, the losers, a draw (only for whoever pasted or drew something), and every spot
 *  the campaign holds at the end (€) */
const PAY_WIN = 250, PAY_LOSE = 80, PAY_DRAW = 150, PAY_SPOT = 5;

type PromiseKind = 'bridge' | 'tram' | 'amnesty';
/** what a promise is called (the slogan on the HUD) and how often it turns up */
const PROMISE_INFO: Record<PromiseKind, { label: string; weight: number }> = {
  bridge: { label: 'Nový most', weight: 0.4 },
  tram: { label: 'Električka do každej obce', weight: 0.35 },
  amnesty: { label: 'Amnestia na pokuty', weight: 0.25 },
};

interface Spot {
  /** index into World.furniture (x, y, angle, kind) */
  f: number;
  x: number;
  y: number;
  kind: number;
  /** the campaign whose poster is up (-1: none yet) */
  owner: number;
  /** that poster has a moustache: it counts for nobody, and anyone can paste over it */
  defaced: boolean;
}

interface Work {
  spot: number;
  kind: 'paste' | 'deface';
  /** sim.time it began, and how long it takes */
  t: number;
  need: number;
  /** where they stood */
  x: number;
  y: number;
}

interface Player {
  team: number;
  work: Work | null;
  /** promises kept for later: the next paste instant (a new bridge), the next few quick (the tram),
   *  the next fine let off (an amnesty with no stars to clear yet) */
  instant: boolean;
  fast: number;
  amnesty: boolean;
  pasted: number;
  defaced: number;
}

/** a campaign promise lying in the city, to pick up */
interface Pledge {
  x: number;
  y: number;
  kind: PromiseKind;
}

class Billboard extends MiniGame {
  spots: Spot[] = [];
  private state = new Map<number, Player>();
  /** which candidate each team campaigns for (the order is drawn per round) */
  private cand: [number, number] = [0, 1];
  /** the AI's next move per team (sim.time); it plays a team nobody's playing */
  private aiAt = [0, 0];
  promises: Pledge[] = [];
  /** sim.time each missing promise turns up again */
  private promiseAt: number[] = [];
  private silence = false;

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = ROUND_S;
  }

  /** The billboards, bus shelters and advertising columns around (x, y) that someone on foot can
   *  reach: false when there are too few for a campaign. */
  pick(x: number, y: number): boolean {
    const w = this.sim.world, f = w.furniture;
    const found = (r: number) => {
      const out: { i: number; d: number }[] = [];
      for (let i = 0; i < f.length; i += 4) {
        const k = f[i + 3];
        if (k !== F_SHELTER && k !== F_BILLBOARD && k !== F_COLUMN) continue;
        const d = dist(f[i], f[i + 1], x, y);
        if (d <= r) out.push({ i, d });
      }
      return out.sort((a, b) => a.d - b.d);
    };
    let near = found(SPOT_R);
    if (near.filter((o) => this.reachable(f[o.i], f[o.i + 1])).length < SPOT_MIN) near = found(SPOT_FAR);
    for (const { i } of near) {
      if (this.spots.length >= SPOT_MAX) break;
      const sx = f[i], sy = f[i + 1];
      if (!this.reachable(sx, sy) || this.spots.some((s) => dist(s.x, s.y, sx, sy) < SPOT_SAME)) continue;
      this.spots.push({ f: i, x: sx, y: sy, kind: f[i + 3], owner: -1, defaced: false });
    }
    return this.spots.length >= SPOT_NONE;
  }

  /** at street level, dry, and by a path people walk (a billboard behind a fence or up on a
   *  motorway embankment is nobody's to paste) */
  private reachable(x: number, y: number) {
    const w = this.sim.world;
    if (w.spawnLevel(x, y, 0.5) !== 0 || w.inWater(x, y, 0) || w.insideBuilding(x, y)) return false;
    const seg = w.ped.segmentAt(x, y, SPOT_PATH);
    if (seg && !seg.edge.noWalk) return true;
    const n = w.walkableNear(x, y);
    return dist(n.x, n.y, x, y) <= SPOT_PATH;
  }

  // --------------------------------------------------------------------------------- the round
  start() {
    const rng = this.sim.rng;
    if (rng.chance(0.5)) this.cand = [1, 0];
    // the teams by the order they joined, the starter's red; alone, the blue campaign is the AI's
    this.players.forEach((p, k) => this.state.set(p.id, { team: k % 2, work: null, instant: false, fast: 0, amnesty: false, pasted: 0, defaced: 0 }));
    this.aiAt = [this.sim.time + rng.range(3, 6), this.sim.time + rng.range(3, 6)];
    for (let k = 0; k < PROMISES; k++) this.placePromise();
    for (const p of this.players) {
      const c = CANDIDATES[this.cand[this.teamOf(p)]];
      this.msg(p, `Kampaň začína! Lep plagáty ${c.gen}: „${c.slogan}“`, TEAM_COLORS[this.teamOf(p)], 4);
    }
  }

  /** `p`'s campaign (0 red, 1 blue) */
  teamOf(p: SimPlayer) {
    return this.state.get(p.id)?.team ?? 0;
  }

  /** a campaign still has a player in it (else the AI runs it) */
  private manned(team: number) {
    return this.players.some((p) => this.state.get(p.id)?.team === team);
  }

  update() {
    const now = this.sim.time;
    if (!this.silence && this.round.left <= SILENCE_S) {
      this.silence = true;
      this.tell('Moratórium! Od teraz sa nelepí – kto lepí, platí pokutu. Fúzy kresliť môžeš.', '#ff5252', 4);
    }
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s) continue;
      if (s.work) this.working(p, s);
      this.pickUp(p, s);
    }
    for (let team = 0; team < 2; team++) if (!this.manned(team) && now >= this.aiAt[team]) this.aiMove(team);
    // promises missing from the map come back after a while
    for (let k = this.promiseAt.length - 1; k >= 0; k--)
      if (now >= this.promiseAt[k] && this.placePromise()) this.promiseAt.splice(k, 1);
  }

  /** a paste or a moustache under way: done when the time's up, off when they moved */
  private working(p: SimPlayer, s: Player) {
    const w = s.work!, sp = this.spots[w.spot], ped = p.ped;
    if (ped.vehicle || ped.aboard || dist(ped.x, ped.y, w.x, w.y) > STILL_R || Math.hypot(ped.vx, ped.vy) > STILL_V) {
      s.work = null;
      return this.msg(p, w.kind === 'paste' ? 'Pohol si sa – plagát spadol.' : 'Pohol si sa – fúzy nedokreslené.', '#ff8a80');
    }
    // the spot changed meanwhile: a teammate was quicker (nothing left to do), or the rival pasted
    // over it first (it wants a moustache now, not a poster)
    const ours = sp.owner === s.team && !sp.defaced, theirs = sp.owner === 1 - s.team && !sp.defaced;
    if (w.kind === 'paste' ? ours : !theirs) {
      s.work = null;
      return;
    }
    if (w.kind === 'paste' && theirs) {
      s.work = null;
      return this.msg(p, 'Súper bol rýchlejší – najprv mu dokresli fúzy.', '#ffd740');
    }
    if (this.sim.time - w.t < w.need) return;
    s.work = null;
    if (w.kind === 'deface') {
      sp.defaced = true;
      s.defaced++;
      this.pop(p, '🥸', sp.x, sp.y - 2);
      return this.msg(p, 'Fúzy sedia. Teraz sa to dá prelepiť.', '#69f0ae', 2);
    }
    sp.owner = s.team;
    sp.defaced = false;
    s.pasted++;
    this.pop(p, CANDIDATES[this.cand[s.team]].short.toUpperCase(), sp.x, sp.y - 2);
    if (this.silence) this.fine(p, s);
  }

  /** pasted during the silence: a fine and a star, unless a promised amnesty lets them off */
  private fine(p: SimPlayer, s: Player) {
    if (s.amnesty) {
      s.amnesty = false;
      return this.msg(p, 'Moratórium porušené – ale sľúbená amnestia platí. Bez pokuty!', '#69f0ae', 3);
    }
    this.sim.addMoney(p, -SILENCE_FINE);
    this.sim.setWanted(p, Math.min(5, p.stars + 1));
    this.pop(p, `−€${SILENCE_FINE}`, p.ped.x, p.ped.y - 1.7);
    this.msg(p, `Porušil si moratórium! Pokuta €${SILENCE_FINE} a polícia ťa hľadá.`, '#ff5252', 3);
  }

  /** a promise lying where `p` is: theirs to keep */
  private pickUp(p: SimPlayer, s: Player) {
    const f = p.focus();
    const k = this.promises.findIndex((q) => dist(q.x, q.y, f.x, f.y) <= PROMISE_REACH);
    if (k < 0) return;
    const pr = this.promises[k];
    this.promises.splice(k, 1);
    const rng = this.sim.rng;
    this.promiseAt.push(this.sim.time + rng.range(PROMISE_NEXT[0], PROMISE_NEXT[1]));
    this.pop(p, '⭐', pr.x, pr.y - 1.5);
    if (pr.kind === 'bridge') {
      s.instant = true;
      return this.msg(p, 'Sľub: Nový most do roka! Ďalší plagát nalepíš raz-dva.', '#ffd54f', 3);
    }
    if (pr.kind === 'tram') {
      s.fast = 2;
      return this.msg(p, 'Sľub: Električka do každej obce! Ďalšie dva plagáty pôjdu rýchlo.', '#ffd54f', 3);
    }
    if (p.wanted > 0) {
      this.sim.setWanted(p, 0);
      return this.msg(p, 'Sľub: Amnestia na pokuty! Polícia ťa už nehľadá.', '#ffd54f', 3);
    }
    s.amnesty = true;
    this.msg(p, 'Sľub: Amnestia na pokuty! Najbližšiu pokutu ti odpustia.', '#ffd54f', 3);
  }

  /** a new promise somewhere among the spots, off the others and away from the players; false when
   *  there's no room for one just now */
  private placePromise(): boolean {
    const w = this.sim.world, rng = this.sim.rng;
    for (let tries = 0; tries < 12; tries++) {
      const sp = rng.pick(this.spots);
      const a = rng.next() * Math.PI * 2, r = rng.range(15, 50);
      const at = w.walkableNear(sp.x + Math.cos(a) * r, sp.y + Math.sin(a) * r);
      if (dist(at.x, at.y, sp.x, sp.y) > 80) continue;
      if (this.promises.some((q) => dist(q.x, q.y, at.x, at.y) < 40)) continue;
      if (this.players.some((p) => dist(p.focus().x, p.focus().y, at.x, at.y) < 30)) continue;
      const kind = rng.weighted(Object.entries(PROMISE_INFO).map(([k, v]) => [k as PromiseKind, v.weight] as const));
      this.promises.push({ x: at.x, y: at.y, kind });
      return true;
    }
    return false;
  }

  /** The AI's move for `team`: paste a free (or moustached) spot, or, with none left (and all
   *  through the silence), draw a moustache on the rival's. Where it's least likely to be seen
   *  doing it: far from the rival's players. */
  private aiMove(team: number) {
    const rng = this.sim.rng;
    // well ahead it takes its time, behind it hurries a little: a race to the end either way
    const [a, b] = this.held();
    const pace = Math.min(AI_LEAD[1], Math.max(AI_LEAD[0], 1 + AI_LEAD[2] * (team === 0 ? a - b : b - a)));
    this.aiAt[team] = this.sim.time + pace * (this.silence ? rng.range(AI_SILENCE[0], AI_SILENCE[1]) : rng.range(AI_EVERY[0], AI_EVERY[1]));
    const foes = this.players.filter((p) => this.teamOf(p) !== team).map((p) => p.focus());
    const far = (s: Spot) => Math.min(Infinity, ...foes.map((f) => dist(f.x, f.y, s.x, s.y)));
    const busy = new Set([...this.state.values()].filter((s) => s.work).map((s) => s.work!.spot));
    const free = (s: Spot, i: number) => !busy.has(i) && far(s) > AI_KEEP_OFF;
    let kind: 'paste' | 'deface' = 'paste';
    let cands = this.silence ? [] : this.spots.filter((s, i) => free(s, i) && (s.owner < 0 || s.defaced));
    if (!cands.length) {
      kind = 'deface';
      cands = this.spots.filter((s, i) => free(s, i) && s.owner === 1 - team && !s.defaced);
    }
    if (!cands.length) return;
    // the farther half, at random
    cands.sort((a, b) => far(b) - far(a));
    const sp = cands[rng.int(Math.max(1, Math.ceil(cands.length / 2)))];
    if (kind === 'paste') {
      sp.owner = team;
      sp.defaced = false;
      return;
    }
    sp.defaced = true;
    const street = this.sim.world.streetName(sp.x, sp.y);
    for (const p of this.players)
      if (this.teamOf(p) !== team) this.msg(p, `🥸 Niekto dokreslil fúzy na tvoj plagát${street ? ` (${street})` : ''}.`, '#ffd740', 2.5);
  }

  onLeave(p: SimPlayer) {
    const s = this.state.get(p.id);
    this.state.delete(p.id);
    if (!s || this.manned(s.team)) return;
    // their campaign carries on without them: the AI runs it from now
    this.aiAt[s.team] = this.sim.time + this.sim.rng.range(AI_EVERY[0], AI_EVERY[1]);
    const c = CANDIDATES[this.cand[s.team]];
    this.tell(`Kampaň ${c.gen} prevzala agentúra.`, '#ffd740', 3);
  }

  // ------------------------------------------------------------------------------- the result
  /** the spots each campaign holds (a moustached poster counts for nobody) */
  held(): [number, number] {
    const n: [number, number] = [0, 0];
    for (const s of this.spots) if (s.owner >= 0 && !s.defaced) n[s.owner]++;
    return n;
  }

  /** the election result, as the percentages of the posters still up */
  private result() {
    const [a, b] = this.held();
    const pa = a + b ? Math.round((a * 100) / (a + b)) : 0;
    const pb = a + b ? 100 - pa : 0;
    return { a, b, line: `${CANDIDATES[this.cand[0]].short} ${pa} % · ${CANDIDATES[this.cand[1]].short} ${pb} %` };
  }

  onTimeout() {
    const r = this.result();
    const winner = r.a > r.b ? 0 : r.b > r.a ? 1 : -1;
    const group = this.players.length > 1;
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s) continue;
      const held = s.team === 0 ? r.a : r.b;
      const won = winner === s.team, draw = winner < 0;
      // a campaign pays its canvassers, not whoever stood about
      const idle = !s.pasted && !s.defaced;
      const pay = (idle ? 0 : draw ? PAY_DRAW : won ? PAY_WIN : PAY_LOSE) + held * PAY_SPOT;
      // the place: the winning campaign first, then who pasted most
      this.addPoints(p, (won ? 1000 : draw ? 500 : 0) + s.pasted * 10 + s.defaced * 3);
      const verdict = idle
        ? 'a ty si nenalepil ani plagát.'
        : draw ? 'remíza, ide sa do 2. kola.' : won ? (group ? 'vyhrali ste!' : 'vyhral si!') : group ? 'prehrali ste.' : 'prehral si.';
      this.outcome(p, { pay, text: `${r.line} – ${verdict}` });
    }
    this.tell(`Volebný výsledok: ${r.line}`, '#fff59d', 4);
    this.finish();
  }

  /** the standings are the campaigns': how many spots each holds */
  board(): [string, number][] {
    const [a, b] = this.held();
    const rows: [string, number][] = [[CANDIDATES[this.cand[0]].short, a], [CANDIDATES[this.cand[1]].short, b]];
    return rows.sort((x, y) => y[1] - x[1]);
  }

  // ------------------------------------------------------------------------------ the action
  /** the spot within `p`'s reach, the nearest */
  private at(p: SimPlayer): number {
    let best = -1, bd = REACH;
    for (let i = 0; i < this.spots.length; i++) {
      const d = dist(this.spots[i].x, this.spots[i].y, p.ped.x, p.ped.y);
      if (d <= bd) (bd = d), (best = i);
    }
    return best;
  }

  /** what the action key would do at spot `i` for `s`'s campaign */
  private can(s: Player, i: number): 'paste' | 'deface' | null {
    const sp = this.spots[i];
    if (sp.owner === 1 - s.team && !sp.defaced) return 'deface';
    if (sp.owner === s.team && !sp.defaced) return null;
    return 'paste';
  }

  act(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (!s || s.work) return;
    if (p.ped.vehicle) return this.msg(p, 'Najprv vystúp – plagáty sa lepia rukami.');
    const i = this.at(p);
    if (i < 0) return;
    const kind = this.can(s, i);
    if (!kind) return this.msg(p, 'Tu už visí tvoj kandidát.', '#b0bec5');
    let need = kind === 'deface' ? DEFACE_S : PASTE_S;
    if (kind === 'paste' && s.instant) {
      s.instant = false;
      need = 0;
    } else if (kind === 'paste' && s.fast > 0) {
      s.fast--;
      need = FAST_S;
    }
    s.work = { spot: i, kind, t: this.sim.time, need, x: p.ped.x, y: p.ped.y };
    if (need === 0) this.working(p, s);
  }

  // --------------------------------------------------------------------------------- the view
  view(p: SimPlayer): MiniView {
    const s = this.state.get(p.id);
    if (!s) return { goal: this.title };
    const me = s.team, ped = p.ped;
    const marks: MiniMark[] = [];
    let arrow = -1, ad = Infinity;
    const f: number[] = [];
    for (let i = 0; i < this.spots.length; i++) {
      const sp = this.spots[i];
      const x = Math.round(sp.x), y = Math.round(sp.y);
      f.push(sp.f, sp.owner < 0 ? 0 : sp.owner + 1 + (sp.defaced ? 2 : 0));
      if (sp.owner < 0) marks.push({ x, y, r: 3, icon: '🪧', label: 'voľný', color: NEUTRAL });
      else if (sp.defaced) marks.push({ x, y, r: 3, icon: '🥸', label: 'fúzy', color: TEAM_COLORS[sp.owner], dim: 1 });
      else marks.push({ x, y, r: 3, icon: '🪧', label: CANDIDATES[this.cand[sp.owner]].short, color: TEAM_COLORS[sp.owner] });
      // the arrow: the nearest spot there's something to do at (in the silence, a rival's poster)
      if (this.can(s, i) && (!this.silence || this.can(s, i) === 'deface')) {
        const d = dist(sp.x, sp.y, ped.x, ped.y);
        if (d < ad) (ad = d), (arrow = marks.length - 1);
      }
    }
    if (arrow >= 0 && !s.work) marks[arrow].arrow = 1;
    for (const pr of this.promises) marks.push({ x: Math.round(pr.x), y: Math.round(pr.y), r: 2, icon: '⭐', label: PROMISE_INFO[pr.kind].label, color: '#ffd54f' });
    const c = CANDIDATES[this.cand[me]];
    const here = this.at(p);
    const kind = here >= 0 && !s.work && !ped.vehicle ? this.can(s, here) : null;
    const act = !kind ? undefined : kind === 'deface' ? 'Dokresliť fúzy' : this.silence ? 'Lepiť aj tak (pokuta!)' : 'Nalepiť plagát';
    const goal = s.work
      ? s.work.kind === 'paste' ? 'Lepím plagát… nehýb sa!' : 'Kreslím fúzy… nehýb sa!'
      : this.silence
        ? 'Moratórium! Nelep. Súperovi fúzy kresliť môžeš.'
        : ped.vehicle && here >= 0
          ? 'Najprv vystúp – plagáty sa lepia rukami.'
          : `Lep plagáty ${c.gen} na bilbordy a zastávky, súperovi dokresli fúzy.`;
    const stats: [string, string][] = [['Voľné', `${this.spots.filter((q) => q.owner < 0).length}`], ['Nalepil si', `${s.pasted}`]];
    const promise = s.instant ? 'Nový most' : s.fast ? `Električka ×${s.fast}` : s.amnesty ? 'Amnestia' : '';
    if (promise) stats.push(['Sľub', promise]);
    const work = s.work;
    return {
      goal,
      stats,
      bar: work
        ? { label: work.kind === 'paste' ? 'Plagát' : 'Fúzy', v: work.need ? Math.round(Math.min(1, (this.sim.time - work.t) / work.need) * 100) / 100 : 1, color: TEAM_COLORS[me] }
        : undefined,
      marks,
      act,
      board: this.board(),
      x: { f, t: me, c: this.cand[0] },
    };
  }

  lobbyView(): MiniView {
    const marks: MiniMark[] = this.spots.map((sp) => ({ x: Math.round(sp.x), y: Math.round(sp.y), r: 3, icon: '🪧', label: 'voľný', color: NEUTRAL }));
    return { goal: 'Voľby na krku. Lepiči plagátov, pripravte sa!', marks };
  }
}

export const BILLBOARD_DEF: MiniGameDef = {
  kind: 'billboard',
  lobby: 20,
  create(sim, round) {
    const g = new Billboard(sim, round);
    return g.pick(round.x, round.y) ? g : 'Tu nie je kde lepiť – bilbordy sú v Petržalke, na Nivách či v Ružinove.';
  },
};
