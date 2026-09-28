// Kolobežky všade (games/scooters.ts, docs/plans/minigames.md): dumped scooters lie about on the
// pavements and in the grass around the start, each with the city's countdown; ridden to a
// bike-share dock and parked (the action key, or just getting off there) they count, left lying too
// long they're lost; riding along the pavement is a fine now and then (the road never); the fridge
// bonus wobbles; with others whoever parks the most wins; and nothing is left behind.
import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/shared/util/math';
import type { Vehicle } from '../../../src/shared/entities/Vehicle';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';

interface Dumped {
  v: Vehicle;
  left: number;
  state: 'lying' | 'parked' | 'lost';
}
/** the game's own state, as the tests read it */
interface Game {
  dumped: Dumped[];
  docks: { x: number; y: number }[];
  fridge: { phase: string; x: number; y: number; bx: number; by: number };
  allowed(x: number, y: number): boolean;
}

function live(seed = 1, at = 'main') {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, at);
  const r = startLive(s, p, 'scooters');
  const g = s.mini.gameOf(p) as unknown as Game;
  return { s, p, r, g };
}

/** `p` gets on dumped scooter `d` where it lies */
function mount(s: MiniSetup, p: SimPlayer, d: Dumped) {
  standAt(p, d.v.x + 0.7, d.v.y);
  expect(s.sim.enterVehicle(p, d.v)).toBe(true);
}

/** a scooter put down, standing, beside (x, y): a side where it's clear */
function putBeside(s: MiniSetup, v: Vehicle, x: number, y: number, r = 2.2) {
  const w = s.sim.world;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (!w.collideCircle(px, py, 0.5, 0, false)) {
      Object.assign(v, { x: px, y: py, vx: 0, vy: 0, av: 0 });
      return;
    }
  }
  Object.assign(v, { x, y, vx: 0, vy: 0, av: 0 });
}

/** points 1 m apart along a polyline */
function along(p: ArrayLike<number>): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k + 3 < p.length; k += 2) {
    const l = dist(p[k], p[k + 1], p[k + 2], p[k + 3]);
    for (let t = 0; t < l; t += 1) out.push({ x: p[k] + ((p[k + 2] - p[k]) * t) / l, y: p[k + 1] + ((p[k + 3] - p[k + 1]) * t) / l });
  }
  return out;
}

/** ride `v` along `pts` (1 m apart) at `speed` */
function ride(s: MiniSetup, v: Vehicle, pts: { x: number; y: number }[], speed = 5) {
  let d = 0;
  run(s.sim, (pts.length - 1) / speed, () => {
    d = Math.min(pts.length - 1.001, d + speed * 0.05);
    const i = Math.floor(d), u = d - i;
    const a = pts[i], b = pts[i + 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    Object.assign(v, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, angle: ang, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, av: 0 });
  });
}

describe('Kolobežky všade', () => {
  it('lays the dumped scooters about on the pavements and in the grass, and marks the docks', () => {
    for (const at of ['main', 'eurovea']) {
      const { s, p, g } = live(2, at);
      const w = s.sim.world;
      expect(g.dumped.length).toBeGreaterThanOrEqual(8);
      expect(g.dumped.length).toBeLessThanOrEqual(12);
      for (const { v } of g.dumped) {
        expect(v.kind).toBe('scooter');
        expect(v.parked).toBe(true);
        expect(s.sim.vehicles).toContain(v);
        const d = dist(v.x, v.y, p.ped.x, p.ped.y);
        expect(d).toBeGreaterThanOrEqual(100);
        expect(d).toBeLessThanOrEqual(450);
        // and a dock within reach of each
        expect(Math.min(...g.docks.map((k) => dist(k.x, k.y, v.x, v.y)))).toBeLessThanOrEqual(220);
        // walkable ground: off the road, dry, outside the buildings, by a path
        expect(w.onCarriageway(v.x, v.y, 0.5)).toBe(false);
        expect(w.inWater(v.x, v.y, 0)).toBe(false);
        expect(w.insideBuilding(v.x, v.y)).toBe(false);
        const n = w.walkableNear(v.x, v.y);
        expect(dist(n.x, n.y, v.x, v.y)).toBeLessThan(40);
      }
      expect(g.docks.length).toBeGreaterThanOrEqual(2);
      run(s.sim, 0.3);
      const st = lastMini(s.priv, p.id)!;
      const scooters = st.marks!.filter((m) => m.icon === '🛴');
      expect(scooters.length).toBe(g.dumped.length);
      expect(scooters.every((m) => g.dumped.some((d) => d.v.id === m.e))).toBe(true);
      expect(st.marks!.filter((m) => m.icon === '🅿️').length).toBe(g.docks.length);
      expect(st.marks!.filter((m) => m.arrow).length).toBe(1);
      expect(scooters[0].label).toMatch(/^pokuta o \d:\d\d$/);
    }
  });

  it('parking one at a dock counts: the action key there, or just getting off', () => {
    const { s, p, g, r } = live(3);
    const [d1, d2] = g.dumped;
    mount(s, p, d1);
    putBeside(s, d1.v, g.docks[0].x, g.docks[0].y);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.act).toBe('Zaparkovať');
    s.mini.act(p);
    expect(d1.state).toBe('parked');
    expect(p.ped.vehicle).toBeNull();
    expect(s.sim.vehicles).not.toContain(d1.v);
    // (the client is told the scooter's gone and where its rider stands)
    expect(s.priv.some(([id, e]) => id === p.id && e.k === 'stored' && e.vehicle === d1.v.id)).toBe(true);
    // the second one: stopped by a dock and got off
    mount(s, p, d2);
    putBeside(s, d2.v, g.docks[1].x, g.docks[1].y);
    run(s.sim, 0.2);
    s.sim.exitVehicle(p);
    run(s.sim, 0.3);
    expect(d2.state).toBe('parked');
    expect(lastMini(s.priv, p.id)!.stats).toContainEqual(['Zaparkované', '2']);
    // away from a dock the action key does nothing
    const d3 = g.dumped[2];
    mount(s, p, d3);
    s.mini.act(p);
    expect(d3.state).toBe('lying');
    expect(messages(s.priv, p.id)).toContain('Zaparkovať sa dá len pri dokovacej stanici.');
    r.left = 0.1;
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.result!.pay).toBe(40);
    expect(miniPay(s.priv, p.id)).toBe(40);
  });

  it('a scooter left lying too long is lost to the city\'s fine; one being ridden waits', () => {
    const { s, p, g } = live(4);
    const soonest = [...g.dumped].sort((a, b) => a.left - b.left);
    const [first, second] = soonest;
    // the second-soonest is ridden meanwhile: its clock stops
    mount(s, p, second);
    const kept = second.left;
    run(s.sim, first.left + 0.5);
    expect(first.state).toBe('lost');
    expect(s.sim.vehicles).not.toContain(first.v);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Mesto pokutovalo operátora'))).toBe(true);
    expect(second.state).toBe('lying');
    expect(second.left).toBe(kept);
  });

  it('riding along the pavement is fined now and then; along the road, never', () => {
    const { s, p, g } = live(5);
    const w = s.sim.world;
    const start = { x: p.ped.x, y: p.ped.y };
    // a footway (a path to walk, away from the streets) near the start
    let path: { x: number; y: number }[] | null = null;
    for (const n of w.ped.nodesAround(start.x, start.y, 50, 700)) {
      for (const l of w.ped.out[n]) {
        const e = l.edge;
        if (e.cls !== 9 || e.noWalk || e.len < 70) continue;
        const pts = along(e.p);
        if (pts.every((q) => !g.allowed(q.x, q.y) && !w.inWater(q.x, q.y, 0) && w.surfaceAt(q.x, q.y, 0) !== 'steps')) path = pts;
        if (path) break;
      }
      if (path) break;
    }
    expect(path).not.toBeNull();
    // the scooter farthest from it, so where the ride began is well away
    const d = [...g.dumped].sort((a, b) => dist(b.v.x, b.v.y, path![0].x, path![0].y) - dist(a.v.x, a.v.y, path![0].x, path![0].y))[0];
    mount(s, p, d);
    ride(s, d.v, path!);
    expect(p.ped.vehicle).toBe(d.v);
    expect(messages(s.priv, p.id)).toContain('Kolobežky na chodník nepatria – zíď na cestu!');
    expect(messages(s.priv, p.id)).toContain('Po chodníku nie! −€10');
    const fined = messages(s.priv, p.id).filter((m) => m === 'Po chodníku nie! −€10').length;
    expect(fined).toBeGreaterThanOrEqual(1);
    // a street's carriageway: no fine at all
    let road: { x: number; y: number }[] | null = null;
    for (const n of w.car.nodesAround(start.x, start.y, 50, 700)) {
      for (const l of w.car.out[n]) {
        const e = l.edge;
        if (e.cls > 5 || e.len < 70) continue;
        const pts = along(e.p);
        if (pts.every((q) => w.onCarriageway(q.x, q.y) && !w.onBridge(q.x, q.y) && w.tunnelDepth(q.x, q.y) < 0)) road = pts;
        if (road) break;
      }
      if (road) break;
    }
    expect(road).not.toBeNull();
    ride(s, d.v, road!);
    expect(messages(s.priv, p.id).filter((m) => m === 'Po chodníku nie! −€10').length).toBe(fined);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.stats).toContainEqual(['Pokuty', `€${fined * 10}`]);
  });

  it('the fridge: loaded on a scooter, it wobbles, falls off when you get off, and pays for the video', () => {
    const { s, p, g, r } = live(6);
    run(s.sim, 21);
    const f = g.fridge;
    expect(f.phase).toBe('ready');
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Bonus: niekto sa sťahuje!'))).toBe(true);
    const d = g.dumped[0];
    mount(s, p, d);
    putBeside(s, d.v, f.x, f.y, 1.5);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.act).toBe('Naložiť chladničku');
    s.mini.act(p);
    expect(f.phase).toBe('carried');
    run(s.sim, 0.3);
    let st = lastMini(s.priv, p.id)!;
    expect(st.x?.wobble).toBe(0.35);
    expect(st.x?.fv).toBe(d.v.id);
    expect(st.marks!.find((m) => m.arrow)?.icon).toBe('🏠');
    // off the scooter: it falls where it was
    s.sim.exitVehicle(p);
    run(s.sim, 0.3);
    expect(f.phase).toBe('ready');
    expect(messages(s.priv, p.id)).toContain('Chladnička spadla! Nalož ju znova.');
    expect(lastMini(s.priv, p.id)!.x?.wobble).toBeUndefined();
    // on again, and on to where it goes
    mount(s, p, d);
    putBeside(s, d.v, f.x, f.y, 1.5);
    run(s.sim, 0.3);
    s.mini.act(p);
    expect(f.phase).toBe('carried');
    putBeside(s, d.v, f.bx, f.by, 1.5);
    run(s.sim, 0.3);
    expect(f.phase).toBe('done');
    expect(messages(s.priv, p.id)).toContain('Polícia: pokuta 50 €, ale video má milión pozretí.');
    st = lastMini(s.priv, p.id)!;
    expect(st.stats).toContainEqual(['Pokuty', '€50']);
    r.left = 0.1;
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.result!.pay).toBe(110 - 50);
    expect(lastMini(s.priv, p.id)!.result!.text).toContain('Chladnička doručená.');
  });

  it('with others: the same scooters for everyone, and whoever parks the most wins', () => {
    const s = setupMini(7, 'server');
    const a = addPlayer(s.sim, 'main', 'Fero');
    const b = addPlayer(s.sim, 'main', 'Jana');
    const r = s.mini.start(a, 'scooters')!;
    s.mini.join(b, r.id);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = s.mini.gameOf(a) as unknown as Game;
    // one more scooter for the second player
    expect(g.dumped.length).toBe(9);
    const park = (p: SimPlayer, d: Dumped, dock: { x: number; y: number }) => {
      mount(s, p, d);
      putBeside(s, d.v, dock.x, dock.y);
      run(s.sim, 0.3);
      s.mini.act(p);
      expect(d.state).toBe('parked');
    };
    park(a, g.dumped[0], g.docks[0]);
    park(a, g.dumped[1], g.docks[0]);
    park(b, g.dumped[2], g.docks[1]);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, a.id)!.board).toEqual([['Fero', 2], ['Jana', 1]]);
    expect(messages(s.priv, b.id)).toContain('Fero zaparkoval kolobežku.');
    r.left = 0.1;
    run(s.sim, 0.3);
    expect(lastMini(s.priv, a.id)!.result!.place).toBe(1);
    expect(lastMini(s.priv, b.id)!.result!.place).toBe(2);
    expect(miniPay(s.priv, a.id)).toBe(2 * 20 + 30);
    expect(miniPay(s.priv, b.id)).toBe(20);
  });

  it('parking every one ends the round early with a bonus, and nothing is left behind', () => {
    const { s, p, g, r } = live(8);
    const all = g.dumped.map((d) => d.v);
    for (const d of g.dumped) {
      mount(s, p, d);
      putBeside(s, d.v, g.docks[0].x, g.docks[0].y);
      run(s.sim, 0.3);
      s.mini.act(p);
    }
    run(s.sim, 0.3);
    expect(r.phase).toBe('done');
    const res = lastMini(s.priv, p.id)!.result!;
    expect(res.text).toContain('Všetky kolobežky zaparkované!');
    expect(res.pay).toBe(g.dumped.length * 20 + 40);
    run(s.sim, DONE_S + 0.5);
    expect(s.mini.all.length).toBe(0);
    for (const v of all) expect(s.sim.vehicles).not.toContain(v);
  });

  it('takes its scooters away when the round ends, from under whoever rides one', () => {
    const { s, p, g } = live(9);
    const all = g.dumped.map((d) => d.v);
    mount(s, p, g.dumped[0]);
    s.mini.leave(p);
    expect(s.mini.all.length).toBe(0);
    expect(p.ped.vehicle).toBeNull();
    for (const v of all) expect(s.sim.vehicles).not.toContain(v);
    // (and the rider's client hears the scooter's gone, rather than riding on a phantom one)
    expect(s.priv.some(([id, e]) => id === p.id && e.k === 'stored' && e.vehicle === all[0].id)).toBe(true);
  });

  it('says so where there are no docks', () => {
    const s = setupMini(10);
    const p = addPlayer(s.sim, { x: -1571, y: -1503 });
    expect(s.mini.start(p, 'scooters')).toBeNull();
    expect(messages(s.priv, p.id).slice(-1)[0]).toContain('Tu nie sú zdieľané kolobežky');
  });
});
