// Kolobežky všade (docs/plans/minigames.md): for years Bratislava's shared e-scooters have been left
// wherever the ride ended: across the pavement, in the grass, down by the Danube. Since 1 September
// 2026 they mustn't be ridden on the pavement either, and this summer the internet had a man riding
// one with a fridge standing on it, and two men riding a couch on a pair of them, stopped right
// outside the regional police headquarters.
//
// The dumped scooters lie about around the player (spawned for the round: on the pavement or in the
// grass, never on the road), each with the city's countdown to a fine for its operator. Ride one to a
// bike-share dock and park it (stop by the dock and get off, or the action key) before its time's up;
// ridden along the pavement rather than the road, it's a fine now and then. Once a round someone
// needs a fridge moved, on a scooter of course (it wobbles). Alone it's against the clock; with
// others, whoever parks the most.
import { dist } from '../../../../util/math';
import { linkPoints } from '../../../../world/Graph';
import { Vehicle } from '../../../../entities/Vehicle';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';

/** a bike-share dock (FURNITURE in world/Street.ts) */
const F_DOCK = 13;
/** the docks: the nearest this many within DOCK_R of the start (m); fewer than DOCK_MIN, no game */
const DOCK_MAX = 12, DOCK_R = 1000, DOCK_MIN = 2;
/** dumped scooters: this many alone, one more for each other player up to SCOOTERS_MAX; lying
 *  between NEAR and FAR from the start (m), APART from each other, OFF_DOCK from any dock and yet
 *  no further than TO_DOCK from the nearest one. It's the walks between them that take the time,
 *  close to a minute a scooter: spread any wider (600 m, a dock 300 m off) a runner saved two in a
 *  round; like this three or four, and more riding a dock's Bolťák from one to the next. */
const SCOOTERS = 8, SCOOTERS_MAX = 12, NEAR = 100, FAR = 450, APART = 40, OFF_DOCK = 35, TO_DOCK = 220;
/** fewer spots for them than this and there's no game here */
const SCOOTERS_MIN = 5;
/** parked: standing (slower than PARK_V, m/s) this close to a dock (m) */
const PARK_R = 3.5, PARK_V = 1;
/** each scooter's countdown to the city's fine for its operator (s), drawn from this range (some
 *  outlast the round: the first ones to go set the pace); it only runs while the scooter lies about */
const FINE_IN: [number, number] = [100, 270];
const ROUND_S = 240;
/** The pavement: a scooter ridden faster than PAVE_V (m/s) off the carriageway (and more than KERB
 *  past its edge, m) for PAVE_M metres on end is fined PAVE_FINE (€), with a warning after PAVE_WARN.
 *  Not on a marked crossing (within CROSSING_R, m), in a car park, nor within FREE_R (m) of a dock or
 *  of where the ride began (a dumped scooter lies on the pavement: it has to get off it somehow). */
const PAVE_V = 1.5, KERB = 0.6, PAVE_M = 30, PAVE_WARN = 8, PAVE_FINE = 10, CROSSING_R = 7, FREE_R = 15;
/** the fridge: turns up this long into the round (s), between these distances from the start and
 *  from its pickup to where it goes (m); loaded from this close (m), delivered this close and this
 *  slow (m, m/s); how much it wobbles; what the video's views pay and what the police fine (€) */
const FRIDGE_AT = 20, FRIDGE_A: [number, number] = [120, 350], FRIDGE_B: [number, number] = [250, 500];
const FRIDGE_REACH = 4, FRIDGE_DROP = 5, FRIDGE_V = 2, FRIDGE_WOBBLE = 0.35, FRIDGE_VIDEO = 110, FRIDGE_FINE = 50;
/** pay (€): each scooter parked; every one of them parked (alone); the most parked (with others) */
const PAY_SCOOTER = 20, PAY_ALL = 40, PAY_BEST = 30;
/** the colours of a scooter's mark by how long it has left */
const GREEN = '#34d186', AMBER = '#ffb300', RED = '#ff5252';

/** "1:05" */
const clock = (s: number) => {
  const n = Math.max(0, Math.ceil(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

interface Dumped {
  v: Vehicle;
  /** seconds until the city fines the operator (runs while it lies about), of how many */
  left: number;
  total: number;
  state: 'lying' | 'parked' | 'lost';
  /** the round's player who rode it last (credited when it stands at a dock) */
  rider: number;
}

interface Player {
  parked: number;
  fines: number;
  /** the fridge's video, once delivered (€) */
  bonus: number;
  /** pavement ridden on end since the last fine (m), and told off for it already */
  pave: number;
  warned: boolean;
  /** where the present ride began */
  from: { x: number; y: number } | null;
}

interface Fridge {
  phase: 'soon' | 'ready' | 'carried' | 'done';
  /** where it stands (ready) */
  x: number;
  y: number;
  /** where it goes */
  bx: number;
  by: number;
  /** who carries it, on which scooter */
  carrier: number;
  v: Vehicle | null;
}

class Scooters extends MiniGame {
  docks: { x: number; y: number }[] = [];
  /** where the dumped scooters will lie: x, y, heading */
  private spots: { x: number; y: number; a: number }[] = [];
  dumped: Dumped[] = [];
  /** the marked crossings around, flat x, y */
  private crossings: number[] = [];
  private state = new Map<number, Player>();
  fridge: Fridge = { phase: 'soon', x: 0, y: 0, bx: 0, by: 0, carrier: 0, v: null };
  /** seconds since the start, and when the fridge turns up */
  private t = 0;
  private fridgeAt = FRIDGE_AT;

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = ROUND_S;
  }

  /** The docks around (x, y), the crossings and where the scooters will lie: false when there
   *  aren't enough of either. */
  pick(x: number, y: number): boolean {
    const w = this.sim.world, f = w.furniture;
    const docks: { x: number; y: number; d: number }[] = [];
    for (let i = 0; i < f.length; i += 4) {
      if (f[i + 3] !== F_DOCK) continue;
      const d = dist(f[i], f[i + 1], x, y);
      if (d <= DOCK_R && w.spawnLevel(f[i], f[i + 1], 0.5) === 0) docks.push({ x: f[i], y: f[i + 1], d });
    }
    docks.sort((a, b) => a.d - b.d);
    this.docks = docks.slice(0, DOCK_MAX).map(({ x, y }) => ({ x, y }));
    if (this.docks.length < DOCK_MIN) return false;
    const cr = w.data.crossings ?? [];
    for (let i = 0; i + 1 < cr.length; i += 4) if (dist(cr[i], cr[i + 1], x, y) < FAR + DOCK_R) this.crossings.push(cr[i], cr[i + 1]);
    for (let tries = 0; tries < SCOOTERS_MAX * 3 && this.spots.length < SCOOTERS_MAX; tries++) {
      const s = this.pavementSpot(x, y, NEAR, FAR, (sx, sy) => {
        const near = Math.min(...this.docks.map((d) => dist(d.x, d.y, sx, sy)));
        return near >= OFF_DOCK && near <= TO_DOCK && this.spots.every((q) => dist(q.x, q.y, sx, sy) >= APART);
      });
      if (s) this.spots.push(s);
    }
    return this.spots.length >= SCOOTERS_MIN;
  }

  /** A spot for something lying about: on a pavement beside a street or in the grass by a path,
   *  between rMin and rMax of (cx, cy), off the road, dry, outside every building, where a scooter
   *  fits and someone on foot gets to; `ok` says what else it needs. Null if none turned up. */
  private pavementSpot(cx: number, cy: number, rMin: number, rMax: number, ok: (x: number, y: number) => boolean) {
    const w = this.sim.world, g = w.ped, rng = this.sim.rng;
    const nodes = g.nodesAround(cx, cy, rMin, rMax);
    if (!nodes.length) return null;
    for (let tries = 0; tries < 60; tries++) {
      const out = g.out[nodes[rng.int(nodes.length)]];
      const e = out[rng.int(out.length)]?.edge;
      if (!e || e.noWalk || e.cls === 10) continue;
      // the walking line on one side of it, and a little further out: the kerbside of a pavement,
      // the grass beside a path
      const side = rng.chance(0.5) ? (e.walkR ?? 0) : (e.walkL ?? 0);
      if (!side) continue;
      const off = side + Math.sign(side) * (e.cls <= 7 ? rng.range(0.4, 1.4) : rng.range(1.2, 2.8));
      const pts = linkPoints({ edge: e, fwd: true, to: e.b }, off);
      const k = rng.int(pts.length / 2 - 1) * 2, u = rng.next();
      const x = pts[k] + (pts[k + 2] - pts[k]) * u, y = pts[k + 1] + (pts[k + 3] - pts[k + 1]) * u;
      const d = dist(x, y, cx, cy);
      if (d < rMin || d > rMax || !ok(x, y)) continue;
      if (w.onCarriageway(x, y, 1.2) || w.inWater(x, y, 0) || w.insideBuilding(x, y) || w.spawnLevel(x, y, 0.6) !== 0 || w.tunnelDepth(x, y) >= 0) continue;
      if (w.surfaceAt(x, y, 0) === 'steps') continue;
      const a = rng.next() * Math.PI * 2;
      if (!this.sim.clearFor(new Vehicle('scooter', x, y, a, GREEN))) continue;
      const n = w.walkableNear(x, y);
      if (dist(n.x, n.y, x, y) > 40) continue;
      return { x, y, a };
    }
    return null;
  }

  // --------------------------------------------------------------------------------- the round
  start() {
    const rng = this.sim.rng;
    for (const p of this.players) this.state.set(p.id, { parked: 0, fines: 0, bonus: 0, pave: 0, warned: false, from: null });
    const want = Math.min(SCOOTERS_MAX, SCOOTERS + this.players.length - 1);
    for (const s of this.spots) {
      if (this.dumped.length >= want) break;
      const v = new Vehicle('scooter', s.x, s.y, s.a, GREEN);
      v.parked = true;
      v.setControls(0, 0, true);
      // (someone may have stopped there since)
      if (!this.sim.clearFor(v)) continue;
      this.spawnVehicle(v);
      const total = Math.round(rng.range(FINE_IN[0], FINE_IN[1]));
      this.dumped.push({ v, left: total, total, state: 'lying', rider: 0 });
    }
    this.tell(`Mesto zaplavili kolobežky (${this.dumped.length}). Zvez ich na parkovisko, kým príde pokuta!`, '#34d186', 4);
  }

  update(dt: number) {
    this.t += dt;
    const sim = this.sim;
    for (const d of this.dumped) {
      if (d.state !== 'lying') continue;
      const v = d.v;
      if (v.wrecked || v.sinking > 0 || !sim.vehicles.includes(v)) {
        this.lose(d, 'Kolobežka je na šrot.');
        continue;
      }
      const rider = v.owner ? this.players.find((p) => p.id === v.owner) : undefined;
      if (rider) {
        d.rider = rider.id;
        continue;
      }
      // left standing at a dock by whoever rode it there: parked
      const by = this.players.find((p) => p.id === d.rider);
      if (by && v.speed < PARK_V && this.dockAt(v.x, v.y) >= 0) {
        this.park(d, by);
        continue;
      }
      d.left -= dt;
      if (d.left <= 0) {
        const street = sim.world.streetName(v.x, v.y);
        this.lose(d, `Mesto pokutovalo operátora – kolobežka prepadla${street ? ` (${street})` : ''}.`);
      }
    }
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (s) this.pavement(p, s, dt);
    }
    this.fridgeStep();
    if (this.dumped.every((d) => d.state !== 'lying') && this.fridge.phase !== 'carried') this.settle();
  }

  /** where `p` rides along the pavement: a fine every so often */
  private pavement(p: SimPlayer, s: Player, dt: number) {
    const v = p.ped.vehicle;
    if (!v || v.kind !== 'scooter') {
      s.pave = 0;
      s.warned = false;
      return;
    }
    if (v.level !== 0 || this.allowed(v.x, v.y) || (s.from && dist(s.from.x, s.from.y, v.x, v.y) < FREE_R)) {
      s.pave = 0;
      s.warned = false;
      return;
    }
    // (standing on the pavement is no crime; the stretch carries on when they ride on)
    if (v.speed < PAVE_V) return;
    s.pave += v.speed * dt;
    if (!s.warned && s.pave >= PAVE_WARN) {
      s.warned = true;
      this.msg(p, 'Kolobežky na chodník nepatria – zíď na cestu!', '#ffd740');
    }
    if (s.pave < PAVE_M) return;
    s.pave = 0;
    s.fines += PAVE_FINE;
    this.pop(p, `−€${PAVE_FINE}`, v.x, v.y - 1.5);
    this.msg(p, `Po chodníku nie! −€${PAVE_FINE}`, '#ff5252');
  }

  /** somewhere a scooter may be ridden: the carriageway (or its very edge), a marked crossing, a car
   *  park, by a dock */
  allowed(x: number, y: number) {
    const w = this.sim.world;
    if (w.onCarriageway(x, y, KERB) || w.inParking(x, y) || this.dockAt(x, y, FREE_R) >= 0) return true;
    const c = this.crossings;
    for (let i = 0; i < c.length; i += 2) if (Math.abs(c[i] - x) < CROSSING_R && Math.abs(c[i + 1] - y) < CROSSING_R && dist(c[i], c[i + 1], x, y) < CROSSING_R) return true;
    return false;
  }

  /** the dock within `r` of (x, y), the nearest (-1: none) */
  private dockAt(x: number, y: number, r = PARK_R) {
    let best = -1, bd = r;
    for (let i = 0; i < this.docks.length; i++) {
      const d = dist(this.docks[i].x, this.docks[i].y, x, y);
      if (d <= bd) (bd = d), (best = i);
    }
    return best;
  }

  /** scooter `d` clicks into the dock: it's `by`'s, and gone into the operator's app */
  private park(d: Dumped, by: SimPlayer) {
    d.state = 'parked';
    const s = this.state.get(by.id);
    if (s) s.parked++;
    this.addPoints(by, 1);
    this.pop(by, `+€${PAY_SCOOTER}`, d.v.x, d.v.y - 1.5);
    // (the walks between them take the time: the dock's own Bolťák is quicker, and it's allowed)
    this.msg(by, s?.parked === 1 ? `Zaparkované! +€${PAY_SCOOTER}. K ďalšej sa zvez Bolťákom z doku.` : `Zaparkované! +€${PAY_SCOOTER}`, '#69f0ae', 2.5);
    for (const q of this.players) if (q !== by) this.msg(q, `${by.nick} zaparkoval kolobežku.`, '#b0bec5', 2);
    this.despawn(d.v);
  }

  private lose(d: Dumped, why: string) {
    d.state = 'lost';
    this.tell(why, '#ff8a80', 3);
    this.unseat(d.v);
    this.despawn(d.v);
  }

  /** Whoever still rides `v` (someone who left the round on it, anyone at the end) steps off beside
   *  it, and their client is told the scooter's gone (`stored`, as for a car put in a garage): online
   *  it drives its own car, and would carry on riding one the server no longer has. */
  private unseat(v: Vehicle) {
    for (const p of this.sim.players.values()) {
      if (p.ped.vehicle !== v) continue;
      this.sim.exitVehicle(p, true, this.sim.world.exitSpot(v, -1));
      this.sim.events.toPlayer(p.id, { k: 'stored', vehicle: v.id, x: p.ped.x, y: p.ped.y });
    }
  }

  dispose() {
    for (const d of this.dumped) if (this.sim.vehicles.includes(d.v)) this.unseat(d.v);
    super.dispose();
  }

  // ------------------------------------------------------------------------------- the fridge
  private fridgeStep() {
    const f = this.fridge;
    if (f.phase === 'soon' && this.t >= this.fridgeAt) this.fridgeAppears();
    if (f.phase !== 'carried') return;
    const p = this.players.find((q) => q.id === f.carrier);
    const v = f.v!;
    if (!p || p.ped.vehicle !== v || v.wrecked) return this.dropFridge(p);
    f.x = v.x;
    f.y = v.y;
    if (dist(v.x, v.y, f.bx, f.by) <= FRIDGE_DROP && v.speed < FRIDGE_V) this.deliver(p);
  }

  /** someone's moving house: the fridge waits at A, and it goes to B */
  private fridgeAppears() {
    const f = this.fridge;
    const a = this.pavementSpot(this.round.x, this.round.y, FRIDGE_A[0], FRIDGE_A[1], () => true);
    const b = a && this.pavementSpot(a.x, a.y, FRIDGE_B[0], FRIDGE_B[1], (x, y) => dist(x, y, this.round.x, this.round.y) <= FAR + 150);
    if (!a || !b) {
      // no room just now: try again in a while
      this.fridgeAt = this.t + 5;
      return;
    }
    Object.assign(f, { phase: 'ready', x: a.x, y: a.y, bx: b.x, by: b.y });
    this.tell('Bonus: niekto sa sťahuje! Odvez chladničku na kolobežke.', '#80deea', 4);
  }

  /** the fridge falls off where `p` (gone, or off the scooter) left it */
  private dropFridge(p: SimPlayer | undefined) {
    const f = this.fridge, v = f.v;
    f.phase = 'ready';
    f.carrier = 0;
    f.v = null;
    if (v) (f.x = v.x), (f.y = v.y);
    if (p) this.msg(p, 'Chladnička spadla! Nalož ju znova.', '#ff8a80', 2.5);
  }

  private deliver(p: SimPlayer) {
    const f = this.fridge, s = this.state.get(p.id);
    f.phase = 'done';
    f.carrier = 0;
    f.v = null;
    if (s) {
      s.bonus += FRIDGE_VIDEO;
      s.fines += FRIDGE_FINE;
    }
    this.pop(p, `+€${FRIDGE_VIDEO - FRIDGE_FINE}`, f.bx, f.by - 1.5);
    this.msg(p, `Polícia: pokuta ${FRIDGE_FINE} €, ale video má milión pozretí.`, '#80deea', 4);
    for (const q of this.players) if (q !== p) this.msg(q, `${p.nick} previezol chladničku na kolobežke. Internet šalie.`, '#b0bec5', 3);
  }

  // ----------------------------------------------------------------------------------- hooks
  onEnter(p: SimPlayer, v: Vehicle) {
    const s = this.state.get(p.id);
    if (!s || v.kind !== 'scooter') return;
    s.from = { x: v.x, y: v.y };
    s.pave = 0;
    const d = this.dumped.find((q) => q.v === v);
    if (d) d.rider = p.id;
  }

  onExit(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (s) s.from = null;
    if (this.fridge.phase === 'carried' && this.fridge.carrier === p.id) this.dropFridge(p);
  }

  onLeave(p: SimPlayer) {
    if (this.fridge.phase === 'carried' && this.fridge.carrier === p.id) this.dropFridge(undefined);
    this.state.delete(p.id);
  }

  // ------------------------------------------------------------------------------ the action
  /** the dumped scooter `p` rides, if any */
  private riding(p: SimPlayer) {
    const v = p.ped.vehicle;
    return v ? this.dumped.find((d) => d.v === v && d.state === 'lying') : undefined;
  }

  /** what the action key does for `p` right now */
  private action(p: SimPlayer): 'park' | 'load' | null {
    const v = p.ped.vehicle;
    if (!v || v.kind !== 'scooter') return null;
    if (this.riding(p) && v.speed < PARK_V + 0.5 && this.dockAt(v.x, v.y) >= 0) return 'park';
    const f = this.fridge;
    if (f.phase === 'ready' && dist(f.x, f.y, v.x, v.y) <= FRIDGE_REACH && v.speed < FRIDGE_V) return 'load';
    return null;
  }

  act(p: SimPlayer) {
    const a = this.action(p), v = p.ped.vehicle;
    if (!a || !v) {
      if (this.riding(p)) this.msg(p, 'Zaparkovať sa dá len pri dokovacej stanici.', '#b0bec5');
      return;
    }
    if (a === 'load') {
      Object.assign(this.fridge, { phase: 'carried', carrier: p.id, v });
      return this.msg(p, 'Chladnička naložená! Drž balans…', '#80deea', 2.5);
    }
    // off the scooter beside the dock, and the scooter into it
    const d = this.riding(p)!;
    this.unseat(v);
    this.park(d, p);
  }

  // ------------------------------------------------------------------------------- the result
  onTimeout() {
    this.settle();
  }

  /** everyone's pay: the scooters they parked, the fridge, less the fines */
  private settle() {
    const group = this.players.length > 1;
    const ranked = this.ranked();
    const top = ranked[0];
    // (a tie for the most is nobody's bonus)
    const leads = top && (ranked.length < 2 || this.pointsOf(top) > this.pointsOf(ranked[1]));
    const n = this.dumped.length;
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s) continue;
      const all = !group && n > 0 && s.parked === n;
      const best = group && p === top && leads && s.parked > 0;
      const pay = s.parked * PAY_SCOOTER + (all ? PAY_ALL : 0) + (best ? PAY_BEST : 0) + s.bonus - s.fines;
      const bits = [all ? 'Všetky kolobežky zaparkované!' : `Zaparkované: ${s.parked} z ${n}${best ? ' – najviac!' : '.'}`];
      if (s.bonus) bits.push('Chladnička doručená.');
      if (s.fines) bits.push(`Pokuty €${s.fines}.`);
      this.outcome(p, { pay, text: s.parked || s.bonus ? bits.join(' ') : 'Ani jedna kolobežka zaparkovaná. Mesto ich má plné.' });
    }
    this.finish();
  }

  // --------------------------------------------------------------------------------- the view
  view(p: SimPlayer): MiniView {
    const s = this.state.get(p.id);
    if (!s) return { goal: this.title };
    const f = p.focus(), f2 = this.fridge, v = p.ped.vehicle;
    const mine = this.riding(p);
    const carrying = f2.phase === 'carried' && f2.carrier === p.id;
    const marks: MiniMark[] = [];
    // what the arrow points at: the fridge's destination, a dock for the scooter they ride, else
    // the nearest scooter lying about
    let arrow = -1, ad = Infinity;
    const aim = (i: number, x: number, y: number) => {
      const d = dist(x, y, f.x, f.y);
      if (d < ad) (ad = d), (arrow = i);
    };
    let urgent: Dumped | null = null;
    for (const d of this.dumped) {
      if (d.state !== 'lying' || d.v === v) continue;
      const rider = d.v.owner ? this.players.find((q) => q.id === d.v.owner) : undefined;
      const color = rider ? '#b0bec5' : d.left < 30 ? RED : d.left < 60 ? AMBER : GREEN;
      marks.push({ x: Math.round(d.v.x), y: Math.round(d.v.y), e: d.v.id, r: 1.5, icon: '🛴', label: rider ? rider.nick : `pokuta o ${clock(d.left)}`, color });
      if (!rider && !mine && !carrying) aim(marks.length - 1, d.v.x, d.v.y);
      if (!rider && (!urgent || d.left < urgent.left)) urgent = d;
    }
    for (const dk of this.docks) {
      marks.push({ x: Math.round(dk.x), y: Math.round(dk.y), r: PARK_R, icon: '🅿️', label: 'dok', color: '#42a5f5' });
      if (mine && !carrying) aim(marks.length - 1, dk.x, dk.y);
    }
    const x: Record<string, number> = {};
    if (f2.phase === 'ready' || f2.phase === 'carried') {
      if (f2.phase === 'ready') {
        marks.push({ x: Math.round(f2.x), y: Math.round(f2.y), r: 2, icon: '🧊', label: 'chladnička', color: '#80deea' });
        x.fx = Math.round(f2.x * 10) / 10;
        x.fy = Math.round(f2.y * 10) / 10;
      } else if (f2.v) x.fv = f2.v.id;
      marks.push({ x: Math.round(f2.bx), y: Math.round(f2.by), r: FRIDGE_DROP, icon: '🏠', label: 'chladnička sem', color: '#80deea' });
      if (carrying) {
        arrow = marks.length - 1;
        x.wobble = FRIDGE_WOBBLE;
      }
    }
    if (arrow >= 0) marks[arrow].arrow = 1;
    const act = this.action(p);
    const lying = this.dumped.filter((d) => d.state === 'lying').length;
    const goal = carrying
      ? 'Chladnička na kolobežke! Dovez ju na miesto – a nespadni.'
      : mine
        ? act === 'park'
          ? 'Si pri doku: zaparkuj, alebo len zosadni.'
          : 'Dovez kolobežku k doku – po ceste, nie po chodníku!'
        : v?.kind === 'scooter' && act === 'load'
          ? 'Nalož chladničku a vezmi ju na miesto.'
          : lying
            ? 'Zvez pohodené kolobežky na parkovisko pri doku, kým mesto napíše pokutu.'
            : 'Kolobežky sú vyriešené.';
    return {
      goal,
      stats: [['Zaparkované', `${s.parked}`], ['Zostáva', `${lying}`], ['Pokuty', `€${s.fines}`]],
      // (rounded: the state goes out again whenever it changes)
      bar: s.pave > 0
        ? { label: 'Chodník!', v: Math.round(Math.min(1, s.pave / PAVE_M) * 100) / 100, color: RED }
        : urgent
          ? { label: `Najbližšia pokuta o ${clock(urgent.left)}`, v: Math.round((urgent.left / urgent.total) * 100) / 100, color: urgent.left < 30 ? RED : urgent.left < 60 ? AMBER : GREEN }
          : undefined,
      marks,
      act: act === 'park' ? 'Zaparkovať' : act === 'load' ? 'Naložiť chladničku' : undefined,
      x,
    };
  }

  lobbyView(): MiniView {
    const marks: MiniMark[] = this.docks.map((d) => ({ x: Math.round(d.x), y: Math.round(d.y), r: PARK_R, icon: '🅿️', label: 'dok', color: '#42a5f5' }));
    return { goal: 'Kolobežky sa váľajú všade. Priprav sa ich upratať!', marks };
  }
}

export const SCOOTERS_DEF: MiniGameDef = {
  kind: 'scooters',
  lobby: 20,
  create(sim, round) {
    const g = new Scooters(sim, round);
    return g.pick(round.x, round.y) ? g : 'Tu nie sú zdieľané kolobežky ani doky – skús centrum.';
  },
};
