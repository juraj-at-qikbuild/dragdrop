// Rozkopávky (games/roadworks.ts, docs/plans/minigames.md): couriers deliver parcels by car to one
// address after another while the streets close: a closure is a barrier and cones across a stretch of
// street; driving into one is a fine (once per closure per car). Alone, NPC crews dig up the streets
// on the courier's way; with others, builders dig where they stand and score on the couriers' fines.
// Everything the round put in the city goes when it's over.
import { describe, expect, it } from 'vitest';
import { Vehicle } from '../../../src/shared/entities/Vehicle';
import { linkPoints } from '../../../src/shared/world/Graph';
import { dist } from '../../../src/shared/util/math';
import type { Prop } from '../../../src/shared/entities/Props';
import type { Sim } from '../../../src/shared/sim/Sim';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, startLive, type MiniSetup } from './helpers';

interface ClosureT {
  x: number;
  y: number;
  a: number;
  hl: number;
  hw: number;
  edge: number;
  by: number;
  props: Prop[];
  hit: Set<number>;
}
/** the game's insides, as far as the tests look */
interface Game {
  closures: ClosureT[];
  st: Map<number, { role: string; drops: number; fines: number; hits: number; dest: { x: number; y: number; label: string } | null; cd: number }>;
}

/** a car for `p` on the nearest street (`at` metres along it), and `p` in it */
function inCar(sim: Sim, p: SimPlayer, at = 0): Vehicle {
  const w = sim.world;
  const n = w.car.nearest(p.ped.x, p.ped.y, 400);
  const l = w.car.out[n][0];
  const pts = linkPoints(l);
  const k = Math.min(1, at / Math.max(1, l.edge.len));
  const x = pts[0] + (pts[pts.length - 2] - pts[0]) * k, y = pts[1] + (pts[pts.length - 1] - pts[1]) * k;
  const v = sim.addVehicle(new Vehicle('sedan', x, y, Math.atan2(pts[3] - pts[1], pts[2] - pts[0]), '#1565c0'));
  p.ped.x = v.x;
  p.ped.y = v.y;
  expect(sim.enterVehicle(p, v)).toBe(true);
  return v;
}

/** the car put down at (x, y), heading `a` at `speed` m/s */
function put(v: Vehicle, x: number, y: number, a: number, speed = 0) {
  v.x = x;
  v.y = y;
  v.angle = a;
  v.vx = Math.cos(a) * speed;
  v.vy = Math.sin(a) * speed;
  v.av = 0;
  v.setControls(0, 0, speed === 0);
}

function game(s: MiniSetup, p: SimPlayer): Game {
  return s.mini.gameOf(p) as unknown as Game;
}

function solo(at: string, seed = 3) {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, at, 'A', 200);
  const car = inCar(s.sim, p);
  startLive(s, p, 'roadworks');
  return { s, p, car, g: game(s, p) };
}

/** the middle of a named street a builder can dig up (a long, wide residential one at street level),
 *  at least 150 m from each of `avoid` and within 600 m of the first, and its direction */
function streetSpot(sim: Sim, avoid: { x: number; y: number }[]) {
  const w = sim.world;
  for (const e of w.car.edges) {
    if (e.cls !== 5 || e.len < 60 || e.width < 6) continue;
    const m = { x: (e.p[0] + e.p[2]) / 2, y: (e.p[1] + e.p[3]) / 2, a: Math.atan2(e.p[3] - e.p[1], e.p[2] - e.p[0]) };
    if (dist(m.x, m.y, avoid[0].x, avoid[0].y) > 600 || avoid.some((q) => dist(q.x, q.y, m.x, m.y) < 150)) continue;
    if (!w.streetName(m.x, m.y) || w.onBridge(m.x, m.y) || w.tunnelDepth(m.x, m.y) >= 0 || !w.car.segmentAt(m.x, m.y, 1)) continue;
    return m;
  }
  throw new Error('no street to dig');
}

/** step the city until the round is over (the result on screen) */
function toEnd(s: MiniSetup, p: SimPlayer) {
  for (let t = 0; t < 300 && s.mini.roundOf(p)?.phase === 'live'; t += 0.05) s.sim.step(0.05);
  expect(s.mini.roundOf(p)?.phase).toBe('done');
}

/** drive `v` into closure `c` along the street at 8 m/s, stepping until it's through */
function driveThrough(s: MiniSetup, v: Vehicle, c: ClosureT) {
  put(v, c.x - Math.cos(c.a) * (c.hl + 4), c.y - Math.sin(c.a) * (c.hl + 4), c.a, 8);
  for (let t = 0; t < 3; t += 0.05) {
    v.vx = Math.cos(c.a) * Math.max(4, v.speed);
    v.vy = Math.sin(c.a) * Math.max(4, v.speed);
    v.angle = c.a;
    s.sim.step(0.05);
  }
}

describe('Rozkopávky', () => {
  it('needs a car', () => {
    const s = setupMini(1);
    const p = addPlayer(s.sim, 'main');
    expect(s.mini.start(p, 'roadworks')).toBeNull();
    expect(messages(s.priv, p.id).at(-1)).toContain('potrebuješ auto');
  });

  it('gives the courier an address across town, and a delivery there pays and brings the next one', () => {
    const { s, p, car, g } = solo('main');
    const st = g.st.get(p.id)!;
    expect(st.role).toBe('courier');
    const d = st.dest!;
    expect(dist(d.x, d.y, car.x, car.y)).toBeGreaterThan(250);
    expect(dist(d.x, d.y, car.x, car.y)).toBeLessThan(800);
    expect(s.sim.world.streetName(d.x, d.y)).toBe(d.label);
    run(s.sim, 0.3);
    const view = lastMini(s.priv, p.id)!;
    const target = view.marks!.find((m) => m.arrow)!;
    expect(target.icon).toBe('📦');
    expect(dist(target.x, target.y, d.x, d.y)).toBeLessThan(1);
    expect(view.goal).toContain(d.label);
    // stopping there hands it over
    put(car, d.x + 3, d.y, 0);
    run(s.sim, 0.2);
    expect(st.drops).toBe(1);
    expect(st.dest).not.toBe(d);
    expect(dist(st.dest!.x, st.dest!.y, d.x, d.y)).toBeGreaterThan(250);
    expect(s.priv.some(([id, e]) => id === p.id && e.k === 'style' && e.label === '+€50')).toBe(true);
    // driving past it at speed doesn't
    const d2 = st.dest!;
    put(car, d2.x, d2.y, 0, 12);
    s.sim.step(0.05);
    expect(st.drops).toBe(1);
    put(car, d2.x, d2.y, 0);
    run(s.sim, 0.2);
    expect(st.drops).toBe(2);
    // at the end: €50 a parcel
    toEnd(s, p);
    expect(lastMini(s.priv, p.id)!.result).toMatchObject({ pay: 100 });
    expect(miniPay(s.priv, p.id)).toBe(100);
  });

  it('NPC crews close streets ahead on the courier\'s way: a barrier and cones across a stretch of street', () => {
    const { s, p, car, g } = solo('kamenne');
    run(s.sim, 8);
    expect(g.closures.length).toBe(1);
    const c = g.closures[0];
    const w = s.sim.world;
    // across a street of the car graph, on the way to the address
    const e = w.car.edges[c.edge];
    const seg = w.car.segmentAt(c.x, c.y, 1)!;
    expect(seg.edge.id).toBe(c.edge);
    const d = g.st.get(p.id)!.dest!;
    const route = w.car.path(w.car.nearest(car.x, car.y, 150), w.car.nearest(d.x, d.y, 150))!;
    let ahead = -1, run0 = 0;
    for (const l of route) {
      if (l.edge.id === c.edge) ahead = run0;
      run0 += l.edge.len;
    }
    expect(ahead).toBeGreaterThanOrEqual(70);
    expect(ahead).toBeLessThanOrEqual(320);
    // the whole street wide, a barrier at one end and cones at the other
    expect(c.hw).toBeCloseTo(e.width / 2 + 0.5, 5);
    expect(c.props.map((q) => q.kind).sort()).toEqual(['barrier', 'cone', 'cone', 'cone']);
    for (const q of c.props) {
      expect(s.sim.props).toContain(q);
      expect(q.level).toBe(0);
      expect(dist(q.x, q.y, c.x, c.y)).toBeLessThan(c.hl + c.hw + 0.5);
    }
    const barrier = c.props.find((q) => q.kind === 'barrier')!;
    expect(barrier.len).toBeGreaterThan(e.width * 0.8);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('🚧'))).toBe(true);
    // on the map: a 🚧 over the stretch
    run(s.sim, 0.3);
    const mark = lastMini(s.priv, p.id)!.marks!.find((m) => m.icon === '🚧')!;
    expect(mark.w).toBeCloseTo(c.hl * 2, 1);
    expect(mark.noMap).toBeUndefined();
    // more come, at most six open at a time, and each moves on after a while
    let most = 0;
    run(s.sim, 200, () => (most = Math.max(most, g.closures.length)));
    expect(most).toBeGreaterThanOrEqual(3);
    expect(most).toBeLessThanOrEqual(6);
    expect(g.closures.every((q) => !q.by)).toBe(true);
  });

  it('driving into a closure is a fine, once per closure per car, and it hurts', () => {
    const { s, p, car, g } = solo('kamenne');
    run(s.sim, 8);
    const c = g.closures[0];
    const hp = car.health;
    driveThrough(s, car, c);
    const st = g.st.get(p.id)!;
    expect(st.fines).toBe(1);
    expect(car.health).toBeLessThan(hp);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('ROZKOPÁVKA!'))).toBe(true);
    expect(s.priv.some(([id, e]) => id === p.id && e.k === 'style' && e.label === 'ROZKOPÁVKA!')).toBe(true);
    // the same car again: no second fine
    driveThrough(s, car, c);
    expect(st.fines).toBe(1);
    // another car through it is another fine
    s.sim.exitVehicle(p);
    const other = s.sim.addVehicle(new Vehicle('hatch', p.ped.x + 3, p.ped.y, 0, '#c62828'));
    p.ped.x = other.x;
    expect(s.sim.enterVehicle(p, other)).toBe(true);
    driveThrough(s, other, c);
    expect(st.fines).toBe(2);
    // the fines come off the pay
    put(other, st.dest!.x, st.dest!.y, 0);
    run(s.sim, 0.2);
    toEnd(s, p);
    expect(lastMini(s.priv, p.id)!.result!.pay).toBe(50 - 2 * 20);
  });

  it('with others: a builder digs up the street they stand on and scores when a courier drives into it', () => {
    const s = setupMini(4, 'server');
    const a = addPlayer(s.sim, 'kamenne', 'Fero', 200);
    const b = addPlayer(s.sim, 'kamenne', 'Jana', 200);
    const ca = inCar(s.sim, a);
    const cb = inCar(s.sim, b, 14);
    const r = s.mini.start(a, 'roadworks')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = game(s, a);
    // the starter's a courier, the second to join a builder
    expect(g.st.get(a.id)!.role).toBe('courier');
    expect(g.st.get(b.id)!.role).toBe('builder');
    // the builder drives off down a street away from the courier (and their address)
    const dest = g.st.get(a.id)!.dest!;
    const one = streetSpot(s.sim, [ca, dest]);
    put(cb, one.x, one.y, one.a);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, b.id)!.act).toBe('Rozkopať ulicu');
    s.mini.act(b);
    expect(g.closures.length).toBe(1);
    const c = g.closures[0];
    expect(c.by).toBe(b.id);
    expect(dist(c.x, c.y, cb.x, cb.y)).toBeLessThan(8);
    // the crew needs a while before the next one
    s.mini.act(b);
    expect(g.closures.length).toBe(1);
    expect(messages(s.priv, b.id).at(-1)).toContain('Partia ešte kope');
    // not right under a courier's wheels
    run(s.sim, 8.5);
    const two = streetSpot(s.sim, [ca, dest, one]);
    const back = { x: ca.x, y: ca.y, a: ca.angle };
    put(ca, two.x + Math.cos(two.a) * 8, two.y + Math.sin(two.a) * 8, two.a);
    put(cb, two.x, two.y, two.a);
    run(s.sim, 0.1);
    s.mini.act(b);
    expect(g.closures.length).toBe(1);
    expect(messages(s.priv, b.id).at(-1)).toContain('nefér');
    put(ca, back.x, back.y, back.a);
    // the courier drives into the builder's closure: a fine for one, a catch for the other
    driveThrough(s, ca, c);
    expect(g.st.get(a.id)!.fines).toBe(1);
    expect(g.st.get(b.id)!.hits).toBe(1);
    expect(messages(s.priv, b.id)).toContain('Fero vletel do tvojej rozkopávky! +60');
    run(s.sim, 0.3);
    expect(lastMini(s.priv, a.id)!.board).toEqual([['Jana', 60], ['Fero', -40]]);
    // the builder sees the courier and where they're going
    const bm = lastMini(s.priv, b.id)!.marks!;
    expect(bm.find((m) => m.icon === '🚚')?.e).toBe(ca.id);
    expect(bm.some((m) => m.icon === '📦' && m.label === 'Fero')).toBe(true);
    toEnd(s, a);
    expect(lastMini(s.priv, b.id)!.result).toMatchObject({ place: 1, pay: 30 + 40 + 40 });
    expect(lastMini(s.priv, a.id)!.result).toMatchObject({ place: 2, pay: 0 });
  });

  it('a builder keeps at most five closures open: a sixth fills in the oldest', () => {
    const s = setupMini(5, 'server');
    const a = addPlayer(s.sim, 'kamenne', 'Fero', 200);
    const b = addPlayer(s.sim, 'kamenne', 'Jana', 200);
    const ca = inCar(s.sim, a);
    const cb = inCar(s.sim, b, 14);
    const r = s.mini.start(a, 'roadworks')!;
    s.mini.join(b, r.id);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = game(s, a);
    const w = s.sim.world;
    const dest = g.st.get(a.id)!.dest!;
    // six streets apart from each other, away from the courier and the address
    const spots: { x: number; y: number; a: number }[] = [];
    for (const e of w.car.edges) {
      if (spots.length >= 6) break;
      if (e.cls !== 5 || e.len < 40 || w.onBridge(e.p[0], e.p[1])) continue;
      const m = { x: (e.p[0] + e.p[2]) / 2, y: (e.p[1] + e.p[3]) / 2, a: Math.atan2(e.p[3] - e.p[1], e.p[2] - e.p[0]) };
      if (dist(m.x, m.y, ca.x, ca.y) < 100 || dist(m.x, m.y, dest.x, dest.y) < 100 || spots.some((q) => dist(q.x, q.y, m.x, m.y) < 60)) continue;
      if (!w.streetName(m.x, m.y) || e.width < 4.4) continue;
      spots.push(m);
    }
    const first: ClosureT[] = [];
    for (const q of spots) {
      put(cb, q.x, q.y, q.a);
      run(s.sim, 8.2);
      s.mini.act(b);
      first.push(g.closures[g.closures.length - 1]);
    }
    const mine = g.closures.filter((c) => c.by === b.id);
    expect(mine.length).toBe(5);
    expect(mine).not.toContain(first[0]);
    for (const q of first[0].props) expect(s.sim.props).not.toContain(q);
  });

  it('everything the round put in the city goes when it is over', () => {
    const { s, p, g } = solo('main', 6);
    run(s.sim, 60);
    expect(g.closures.length).toBeGreaterThan(0);
    expect(s.sim.props.length).toBe(g.closures.length * 4);
    toEnd(s, p);
    run(s.sim, DONE_S + 0.5);
    expect(s.mini.all.length).toBe(0);
    expect(s.sim.props.length).toBe(0);
    // leaving mid-way does the same
    const t = solo('kamenne', 7);
    run(t.s.sim, 30);
    expect(t.s.sim.props.length).toBeGreaterThan(0);
    t.s.mini.leave(t.p);
    expect(t.s.sim.props.length).toBe(0);
  });
});
