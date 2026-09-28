// Rozkopávky (docs/plans/minigames.md): every summer half of Bratislava is dug up at once – the bridge
// repairs, the tram lines closed for track works, the detours and the jams that come with them. The
// players are couriers with parcels to deliver by car, one address after another, while the streets
// close around them: a closure is a stretch of street fenced off with a barrier and cones, and a car
// that drives into it pays a fine (and its suspension feels the hole). The couriers' GPS doesn't know
// about any of it; the map does.
//
// Alone, NPC crews dig up the streets ahead on the courier's likely way to the next address, and move
// on after a while. With others, the players split into couriers and builders: a builder digs up the
// street they stand or drive on (the action key) and scores whenever a courier drives into one of
// theirs.
import { dist } from '../../../../util/math';
import type { Edge, Link } from '../../../../world/Graph';
import type { World } from '../../../../world/World';
import type { Vehicle } from '../../../../entities/Vehicle';
import { Prop } from '../../../../entities/Props';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { pickInBand } from '../../jobs/courier';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import { MINI_INFO } from '../catalog';
import type { MiniMark } from '../types';

/** the round (s) */
const DURATION = 240;
/** the next address is this far from the last one (m, as the crow flies) */
const DROP_BAND: [number, number] = [300, 750];
/** a parcel is handed over stopping (slower than DROP_SPEED, m/s) within DROP_R (m) of the address */
const DROP_R = 12, DROP_SPEED = 3;
/** a closure: this long along the street (m), a metre wider than it, and open this long (s) */
const CLOSE_L = 14;
const CLOSE_LIFE: [number, number] = [70, 100];
/** closures keep at least this far apart (m), and none is dug this close to a courier or to a
 *  courier's address (m) */
const CLOSE_GAP = 30, FAIR_R = 20, ADDRESS_R = 25;
/** who's digging this time (the label on the map) */
const CREWS = ['vodovod', 'teplovod', 'nové koľaje', 'kanalizácia', 'optika', 'nový asfalt', 'plynovod'];
/** the NPC crews: a new closure every so often (s), at most this many open, on the courier's way
 *  somewhere this far ahead (m, along the road), preferably out of sight */
const NPC_EVERY: [number, number] = [20, 30];
const NPC_FIRST = 6, NPC_MAX = 6;
const NPC_AHEAD: [number, number] = [70, 320];
/** a builder digs every BUILD_CD seconds at most, and has BUILD_MAX closures open at once (a new one
 *  fills in the oldest) */
const BUILD_CD = 8, BUILD_MAX = 5;
/** a builder digs where they are within this of a street's centre line (m) */
const BUILD_R = 7;
/** pay: a delivery, a fine, a builder's catch and their day rate, the group's winner */
const PAY_DROP = 50, FINE = 20, PAY_HIT = 40, PAY_BUILDER = 30, WIN_BONUS = 40;
/** standings: a delivery, a fine (taken off), a builder's catch */
const PTS_DROP = 100, PTS_FINE = 40, PTS_HIT = 60;
/** the jolt of the hole: this much of the speed goes, and this much damage */
const JOLT = 0.6, JOLT_DMG = 4;
const ORANGE = MINI_INFO.roadworks.color, CONE = '#ff6d00', OK = '#69f0ae', BAD = '#ff5252', WARN = '#ffd740';

interface Closure {
  /** the stretch's centre, and the street's direction there */
  x: number;
  y: number;
  a: number;
  /** half its length along the street, half its width across (m) */
  hl: number;
  hw: number;
  edge: number;
  /** the builder's player id (0: an NPC crew) */
  by: number;
  /** when it reopens (sim.time) */
  until: number;
  /** the vehicles that drove into it (each pays once) */
  hit: Set<number>;
  props: Prop[];
  /** the street, and who's digging it */
  label: string;
  crew: string;
}

interface Address {
  x: number;
  y: number;
  label: string;
  edge: number;
}

interface Player {
  role: 'courier' | 'builder';
  drops: number;
  fines: number;
  /** a builder's: couriers who drove into their closures */
  hits: number;
  dest: Address | null;
  /** a builder can dig again at this sim.time */
  cd: number;
}

/** Who's a builder with others: one for every three players (at least one), the second, fifth…
 *  to join; the starter is always a courier. */
function isBuilder(i: number, n: number): boolean {
  return n > 1 && i % 3 === 1 && Math.floor(i / 3) < Math.max(1, Math.floor(n / 3));
}

/** a car, not a scooter, a bike or a boat */
const isCar = (v: Vehicle | null | undefined): v is Vehicle => !!v && !v.spec.twoWheeler && !v.spec.boat;

/** at street level the whole way: no bridge deck, no tunnel */
function onGround(w: World, e: Edge): boolean {
  const p = e.p;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const n = Math.max(1, Math.ceil(Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 8));
    for (let k = 0; k <= n; k++) {
      const x = p[i] + ((p[i + 2] - p[i]) * k) / n, y = p[i + 1] + ((p[i + 3] - p[i + 1]) * k) / n;
      if (w.onBridge(x, y) || w.tunnelDepth(x, y) >= 0) return false;
    }
  }
  return true;
}

/** the point and heading at arc length `s` along a flat polyline */
function along(p: ArrayLike<number>, s: number): { x: number; y: number; a: number } {
  let acc = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1], l = Math.hypot(dx, dy);
    if (acc + l >= s || i + 4 >= p.length) {
      const t = l ? Math.min(1, Math.max(0, (s - acc) / l)) : 0;
      return { x: p[i] + dx * t, y: p[i + 1] + dy * t, a: Math.atan2(dy, dx) };
    }
    acc += l;
  }
  return { x: p[0], y: p[1], a: 0 };
}

/** the streets that can be dug up or delivered to, by edge id, worked out once per map */
const diggable = new WeakMap<World, Map<number, Address>>();
function streets(w: World): Map<number, Address> {
  let m = diggable.get(w);
  if (m) return m;
  m = new Map();
  for (const e of w.car.edges) {
    if (e.cls < 3 || e.cls > 6 || e.len < 20 || e.width < 4.4 || (e.blockedF && e.blockedR) || !onGround(w, e)) continue;
    const mid = along(e.p, e.len / 2);
    const label = w.streetName(mid.x, mid.y);
    if (label) m.set(e.id, { x: mid.x, y: mid.y, label, edge: e.id });
  }
  diggable.set(w, m);
  return m;
}

class Roadworks extends MiniGame {
  private st = new Map<number, Player>();
  private closures: Closure[] = [];
  private addresses: Address[];
  private nextNpc = 0;
  private group = false;

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = DURATION;
    this.addresses = [...streets(sim.world).values()];
  }

  // -------------------------------------------------------------------------------- the round
  start() {
    const sim = this.sim;
    this.group = this.round.started >= 2;
    // with others, some of them are builders (by the order they joined in)
    const n = this.players.length;
    this.players.forEach((p, i) => {
      const role = this.group && isBuilder(i, n) ? 'builder' : 'courier';
      this.st.set(p.id, { role, drops: 0, fines: 0, hits: 0, dest: null, cd: 0 });
    });
    for (const p of this.players) {
      const s = this.st.get(p.id)!;
      if (s.role === 'courier') {
        s.dest = this.nextAddress(p.focus());
        this.msg(p, 'Rozvážaš zásielky. Pozor na rozkopávky – GPS o nich nevie!', ORANGE, 4);
      } else this.msg(p, 'Si stavbár! Rozkopávaj ulice kuriérom pred nosom (B).', ORANGE, 4);
    }
    this.nextNpc = sim.time + NPC_FIRST;
  }

  onLeave(p: SimPlayer) {
    this.st.delete(p.id);
  }

  private couriers(): SimPlayer[] {
    return this.players.filter((p) => this.st.get(p.id)?.role === 'courier');
  }

  update() {
    const sim = this.sim;
    // with nobody left to deliver, it's over
    if (!this.couriers().length) {
      this.settle();
      return this.finish();
    }
    for (const c of [...this.closures]) if (sim.time >= c.until) this.reopen(c);
    for (const p of this.couriers()) this.courier(p, this.st.get(p.id)!);
    // the NPC crews dig alone, or when every builder has gone home
    if (sim.time >= this.nextNpc && !this.players.some((p) => this.st.get(p.id)?.role === 'builder')) {
      this.nextNpc = sim.time + (this.npcDig() ? sim.rng.range(NPC_EVERY[0], NPC_EVERY[1]) : 4);
    }
  }

  onTimeout() {
    this.settle();
    this.finish();
  }

  /** a courier's step: into a closure is a fine (once each), stopping at the address a delivery */
  private courier(p: SimPlayer, s: Player) {
    const v = p.ped.vehicle;
    if (!v) return;
    for (const c of this.closures) {
      if (c.hit.has(v.id) || v.level !== 0 || !this.inside(v.x, v.y, c)) continue;
      c.hit.add(v.id);
      this.fined(p, s, v, c);
    }
    const d = s.dest;
    if (d && isCar(v) && v.speed < DROP_SPEED && dist(v.x, v.y, d.x, d.y) <= DROP_R) {
      s.drops++;
      this.addPoints(p, PTS_DROP);
      this.pop(p, `+€${PAY_DROP}`, v.x, v.y - 1.5);
      s.dest = this.nextAddress(d);
      this.msg(p, `Doručené! Ďalšia zásielka: ${s.dest ? s.dest.label : '…'}`, OK, 3);
    }
  }

  /** ROZKOPÁVKA! A fine, the jolt of the hole, and a point for whoever dug it */
  private fined(p: SimPlayer, s: Player, v: Vehicle, c: Closure) {
    const sim = this.sim;
    s.fines++;
    this.addPoints(p, -PTS_FINE);
    this.pop(p, 'ROZKOPÁVKA!', v.x, v.y - 1.5);
    this.msg(p, `ROZKOPÁVKA! Pokuta €${FINE} a podvozok to cítil.`, BAD, 3);
    sim.damageVehicle(v, JOLT_DMG, 0, { dvx: -v.vx * JOLT, dvy: -v.vy * JOLT, dav: (sim.rng.next() - 0.5) * 1.2 });
    const b = c.by ? this.players.find((q) => q.id === c.by) : undefined;
    const bs = b && this.st.get(b.id);
    if (b && bs) {
      bs.hits++;
      this.addPoints(b, PTS_HIT);
      this.msg(b, `${p.nick} vletel do tvojej rozkopávky! +${PTS_HIT}`, OK, 3);
    }
  }

  // ------------------------------------------------------------------------------ the addresses
  /** The next address: somewhere on a named street DROP_BAND away from `from`, not the one just
   *  delivered to. */
  private nextAddress(from: { x: number; y: number; edge?: number }): Address | null {
    const list = this.addresses.filter((a) => a.edge !== from.edge);
    return pickInBand(this.sim, list, from.x, from.y, DROP_BAND);
  }

  // ------------------------------------------------------------------------------- the closures
  /** (x, y) inside closure `c` */
  private inside(x: number, y: number, c: Closure): boolean {
    const dx = x - c.x, dy = y - c.y, ca = Math.cos(c.a), sa = Math.sin(c.a);
    return Math.abs(dx * ca + dy * sa) <= c.hl && Math.abs(-dx * sa + dy * ca) <= c.hw;
  }

  /** why a closure can't go at (x, y), or null when it can */
  private blocked(x: number, y: number): string | null {
    if (this.closures.some((c) => dist(c.x, c.y, x, y) < CLOSE_GAP)) return 'Tu už sa kope – skús inde.';
    for (const p of this.couriers()) {
      const f = p.focus(), d = this.st.get(p.id)?.dest;
      if (dist(f.x, f.y, x, y) < FAIR_R) return 'Kuriér je priblízko – to by bolo nefér.';
      if (d && dist(d.x, d.y, x, y) < ADDRESS_R) return 'Tu má kuriér adresu – tu kopať nesmieš.';
    }
    return null;
  }

  /** Fence off the stretch of `edge` centred `s` metres along it: a barrier across at one end, cones
   *  at the other, open for a minute or so. */
  private dig(e: Edge, s: number, by: number): Closure {
    const sim = this.sim;
    const hl = Math.min(CLOSE_L / 2, e.len / 2 - 1);
    const at = along(e.p, Math.max(hl, Math.min(e.len - hl, s)));
    const hw = e.width / 2 + 0.5;
    const fx = Math.cos(at.a), fy = Math.sin(at.a), rx = -fy, ry = fx;
    const c: Closure = {
      x: at.x, y: at.y, a: at.a, hl, hw, edge: e.id, by, until: sim.time + sim.rng.range(CLOSE_LIFE[0], CLOSE_LIFE[1]),
      hit: new Set(), props: [], label: sim.world.streetName(at.x, at.y) ?? 'ulica', crew: sim.rng.pick(CREWS),
    };
    c.props.push(this.spawnProp(new Prop('barrier', at.x - fx * hl, at.y - fy * hl, at.a, 0, e.width * 0.85)));
    for (const k of [-1, 0, 1]) {
      const o = (k * e.width) / 3;
      c.props.push(this.spawnProp(new Prop('cone', at.x + fx * hl + rx * o, at.y + fy * hl + ry * o, at.a, 0, 0.5)));
    }
    this.closures.push(c);
    return c;
  }

  /** the crew moves on: the street's open again */
  private reopen(c: Closure) {
    for (const pr of c.props) this.despawn(pr);
    this.closures.splice(this.closures.indexOf(c), 1);
  }

  /** An NPC crew digs up a street ahead on a courier's way to their address: somewhere 70–320 m on
   *  along the road, out of sight if it can be. Returns whether it found one. */
  private npcDig(): boolean {
    const sim = this.sim, w = sim.world, rng = sim.rng;
    const couriers = this.couriers().filter((p) => this.st.get(p.id)!.dest);
    if (!couriers.length) return false;
    const p = rng.pick(couriers);
    const s = this.st.get(p.id)!, d = s.dest!;
    const f = p.focus();
    const from = w.car.nearest(f.x, f.y, 150), to = w.car.nearest(d.x, d.y, 150);
    const route: Link[] = (from >= 0 && to >= 0 && w.car.path(from, to)) || [];
    const ok = streets(w);
    const cands: { l: Link; hidden: boolean }[] = [];
    let run = 0;
    for (const l of route) {
      const start = run;
      run += l.edge.len;
      if (start < NPC_AHEAD[0] || start > NPC_AHEAD[1] || !ok.has(l.edge.id)) continue;
      const mid = along(l.edge.p, l.edge.len / 2);
      if (this.blocked(mid.x, mid.y)) continue;
      cands.push({ l, hidden: !sim.visibleToAny(mid.x, mid.y, 10) });
    }
    if (!cands.length) return false;
    const hidden = cands.filter((c) => c.hidden);
    const { l } = rng.pick(hidden.length ? hidden : cands);
    // at most NPC_MAX open: the oldest crew moves on first
    const npc = this.closures.filter((c) => !c.by);
    if (npc.length >= NPC_MAX) this.reopen(npc[0]);
    const c = this.dig(l.edge, l.edge.len / 2, 0);
    this.msg(p, `🚧 ${c.label}: rozkopávka (${c.crew}) na tvojej trase – hľadaj obchádzku!`, WARN, 3);
    return true;
  }

  // ------------------------------------------------------------------------------- the builders
  /** where a builder would dig now: the street they're on, or why not */
  private digSpot(p: SimPlayer, s: Player): { e: Edge; s: number } | string {
    const sim = this.sim, w = sim.world;
    if (sim.time < s.cd) return `Partia ešte kope (${Math.ceil(s.cd - sim.time)} s).`;
    const f = p.focus();
    if (p.focusLevel() !== 0) return 'Tu sa kopať nedá.';
    const seg = w.car.segmentAt(f.x, f.y, BUILD_R);
    if (!seg || !streets(w).has(seg.edge.id)) return 'Postav sa na ulicu – tu sa kopať nedá.';
    const why = this.blocked(f.x, f.y);
    if (why) return why;
    // how far along the edge the builder is
    const e = seg.edge, p0 = e.p;
    let best = 0, bd = Infinity, acc = 0;
    for (let i = 0; i + 3 < p0.length; i += 2) {
      const ax = p0[i], ay = p0[i + 1], ux = p0[i + 2] - ax, uy = p0[i + 3] - ay, l2 = ux * ux + uy * uy, l = Math.sqrt(l2);
      const t = l2 ? Math.min(1, Math.max(0, ((f.x - ax) * ux + (f.y - ay) * uy) / l2)) : 0;
      const d = dist(ax + ux * t, ay + uy * t, f.x, f.y);
      if (d < bd) (bd = d), (best = acc + l * t);
      acc += l;
    }
    return { e, s: best };
  }

  act(p: SimPlayer) {
    const s = this.st.get(p.id);
    if (!s || s.role !== 'builder') return;
    const spot = this.digSpot(p, s);
    if (typeof spot === 'string') return this.msg(p, spot, WARN);
    const mine = this.closures.filter((c) => c.by === p.id);
    if (mine.length >= BUILD_MAX) this.reopen(mine[0]);
    const c = this.dig(spot.e, spot.s, p.id);
    c.until = this.sim.time + CLOSE_LIFE[1];
    s.cd = this.sim.time + BUILD_CD;
    this.pop(p, '🚧', c.x, c.y - 1.5);
    this.msg(p, `Rozkopané: ${c.label}.`, ORANGE);
  }

  // ----------------------------------------------------------------------------------- the end
  /** everyone's pay: couriers by their deliveries less the fines, builders by their catches */
  private settle() {
    const ranked = this.ranked();
    for (const p of this.players) {
      const s = this.st.get(p.id);
      if (!s) continue;
      const won = this.group && ranked[0] === p;
      const bonus = won ? WIN_BONUS : 0;
      if (s.role === 'builder') {
        const text = s.hits ? `Kuriéri ti vleteli do rozkopávok ${s.hits}×. Dobrá robota, majstre!` : 'Nikto ti do jamy nevletel. Zajtra zase.';
        this.outcome(p, { pay: PAY_BUILDER + s.hits * PAY_HIT + bonus, text });
      } else {
        const parcels = s.drops === 1 ? 'zásielku' : s.drops >= 2 && s.drops <= 4 ? 'zásielky' : 'zásielok';
        const text = `Doručil si ${s.drops} ${parcels}${s.fines ? `, pokuty za rozkopávky: ${s.fines}` : ' a obišiel si všetky rozkopávky'}.`;
        this.outcome(p, { pay: Math.max(0, s.drops * PAY_DROP - s.fines * FINE) + bonus, text });
      }
    }
  }

  // ---------------------------------------------------------------------------------- the view
  private closureMark(c: Closure, mine: boolean): MiniMark {
    const r = (v: number) => Math.round(v * 10) / 10;
    return { x: r(c.x), y: r(c.y), w: r(c.hl * 2), h: r(c.hw * 2), a: Math.round(c.a * 100) / 100, icon: '🚧', label: mine ? 'tvoja' : c.crew, color: CONE };
  }

  view(p: SimPlayer): MiniView {
    const s = this.st.get(p.id);
    if (!s) return { goal: 'Rozkopávky' };
    const sim = this.sim;
    const marks: MiniMark[] = this.closures.map((c) => this.closureMark(c, c.by === p.id));
    if (s.role === 'courier') {
      const d = s.dest;
      if (d) marks.unshift({ x: Math.round(d.x), y: Math.round(d.y), r: DROP_R, icon: '📦', label: d.label, color: ORANGE, arrow: 1 });
      // the builders, to keep an eye on
      for (const q of this.players) {
        if (this.st.get(q.id)?.role !== 'builder') continue;
        const f = q.focus(), v = q.ped.vehicle;
        marks.push({ x: Math.round(f.x), y: Math.round(f.y), e: v ? v.id : q.ped.id, icon: '👷', label: q.nick, color: WARN });
      }
      const car = isCar(p.ped.vehicle);
      // (the distance in tens of metres: the line changes as it gets nearer, not with every step)
      const far = Math.round(dist(p.focus().x, p.focus().y, d?.x ?? 0, d?.y ?? 0) / 10) * 10;
      const goal = !d ? 'Zásielky došli – dojazdi si to.' : car ? `Doruč zásielku: ${d.label} (${far} m)` : 'Nastúp do auta – zásielky vozíš autom.';
      return {
        goal,
        stats: [['Doručené', `${s.drops}`], ['Pokuty', `${s.fines}`], ['Zarobené', `€${Math.max(0, s.drops * PAY_DROP - s.fines * FINE)}`]],
        marks,
      };
    }
    // a builder sees the couriers and where they're going
    for (const q of this.couriers()) {
      const qs = this.st.get(q.id)!;
      const f = q.focus(), v = q.ped.vehicle;
      marks.push({ x: Math.round(f.x), y: Math.round(f.y), e: v ? v.id : q.ped.id, icon: '🚚', label: q.nick, color: '#4fc3f7' });
      if (qs.dest) marks.push({ x: Math.round(qs.dest.x), y: Math.round(qs.dest.y), icon: '📦', label: q.nick, color: ORANGE, dim: 1 });
    }
    const spot = this.digSpot(p, s);
    const mine = this.closures.filter((c) => c.by === p.id).length;
    // the arrow: the nearest courier
    let best = -1, bd = Infinity;
    const f = p.focus();
    marks.forEach((m, i) => {
      if (m.icon !== '🚚') return;
      const d = dist(m.x, m.y, f.x, f.y);
      if (d < bd) (bd = d), (best = i);
    });
    if (best >= 0) marks[best].arrow = 1;
    const cd = Math.max(0, s.cd - sim.time);
    return {
      goal: 'Rozkopávaj ulice kuriérom pred nosom – postav sa na cestu a stlač B.',
      stats: [['Zásahy', `${s.hits}`], ['Rozkopávky', `${mine}/${BUILD_MAX}`]],
      bar: cd > 0 ? { label: 'Partia kope', v: 1 - cd / BUILD_CD, color: ORANGE } : undefined,
      marks,
      act: typeof spot === 'string' ? undefined : 'Rozkopať ulicu',
    };
  }

  lobbyView(p: SimPlayer): MiniView {
    const builder = isBuilder(this.players.indexOf(p), this.players.length);
    return { goal: builder ? 'Budeš stavbár: rozkopávaj ulice kuriérom pred nosom.' : 'Leto v Blave: zásielky čakajú a ulice sa zatvárajú…' };
  }
}

export const ROADWORKS_DEF: MiniGameDef = {
  kind: 'roadworks',
  lobby: 20,
  check(_sim, p) {
    return isCar(p.ped.vehicle) ? null : 'Na toto potrebuješ auto – nie kolobežku, bicykel ani loď.';
  },
  create(sim, round) {
    const g = new Roadworks(sim, round);
    return streets(sim.world).size ? g : 'Tu sa nedá nič rozvážať.';
  },
};
