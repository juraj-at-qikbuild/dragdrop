// Parkovací hon (games/parking.ts, docs/plans/minigames.md): a PAAS zone of a few streets near the
// player with bays at the kerb; the scan car sweeps it and fines any car it finds outside a bay or
// in one without a ticket from the app; NPC drivers take the bays; the city repaints bays after each
// sweep; two fines and you're out; with others the last one standing wins; the round's cars go when
// it's over.
import { describe, expect, it } from 'vitest';
import { Vehicle } from '../../../src/shared/entities/Vehicle';
import { linkPoints, type Link } from '../../../src/shared/world/Graph';
import { dist } from '../../../src/shared/util/math';
import type { PrivateEvent } from '../../../src/shared/sim/events';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import type { Sim } from '../../../src/shared/sim/Sim';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, startLive, type MiniSetup } from './helpers';

interface BayT {
  x: number;
  y: number;
  a: number;
  li: number;
  gone: boolean;
  by: Vehicle | null;
}
/** the game's insides, as far as the tests look */
interface Game {
  zone: { links: Link[]; slots: BayT[]; len: number; cx: number; cy: number };
  bays: BayT[];
  rivals: { v: Vehicle; state: string }[];
  scan: Vehicle;
  sweep: number;
  sweeping: boolean;
  nextAt: number;
  st: Map<number, { car: Vehicle | null; fines: number; ok: number; out: boolean }>;
}

/** the point `s` metres along a flat polyline (from its end when `s` is negative), and its heading */
function along(pts: number[], s: number) {
  const p = s < 0 ? reverse(pts) : pts;
  let left = Math.abs(s);
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1], l = Math.hypot(dx, dy);
    if (l >= left || i + 4 >= p.length) {
      const t = l ? Math.min(1, left / l) : 0;
      const a = Math.atan2(dy, dx) + (s < 0 ? Math.PI : 0);
      return { x: p[i] + dx * t, y: p[i + 1] + dy * t, a };
    }
    left -= l;
  }
  return { x: p[0], y: p[1], a: 0 };
}

function reverse(pts: number[]) {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

/** a car for `p` on the nearest street (`at` metres along it), and `p` in it */
function inCar(sim: Sim, p: SimPlayer, at = 0): Vehicle {
  const w = sim.world;
  const n = w.car.nearest(p.ped.x, p.ped.y, 400);
  const l = w.car.out[n][0];
  const q = along(linkPoints(l), Math.min(at, l.edge.len - 2));
  const v = sim.addVehicle(new Vehicle('sedan', q.x, q.y, q.a, '#1565c0'));
  p.ped.x = v.x;
  p.ped.y = v.y;
  expect(sim.enterVehicle(p, v)).toBe(true);
  return v;
}

/** the car put down standing in bay `b` */
function parkIn(car: Vehicle, b: { x: number; y: number; a: number }) {
  car.x = b.x;
  car.y = b.y;
  car.angle = b.a;
  car.vx = car.vy = car.av = 0;
  car.setControls(0, 0, true);
}

function game(s: MiniSetup, p: SimPlayer): Game {
  return s.mini.gameOf(p) as unknown as Game;
}

/** a started round for a player in a car at `at` */
function solo(at: string, seed = 3) {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, at, 'A', 200);
  const car = inCar(s.sim, p);
  startLive(s, p, 'parking');
  return { s, p, car, g: game(s, p) };
}

/** step until `until` says so (or `max` seconds), calling it after every step with the new events */
function runUntil(s: MiniSetup, max: number, until: (fresh: [number, PrivateEvent][]) => boolean): boolean {
  let seen = s.priv.length;
  let hit = false;
  const dt = 0.05;
  for (let t = 0; t < max && !hit; t += dt) {
    s.sim.step(dt);
    const fresh = s.priv.slice(seen);
    seen = s.priv.length;
    hit = until(fresh);
  }
  return hit;
}

const said = (fresh: [number, PrivateEvent][], pid: number, text: string) => fresh.some(([id, e]) => id === pid && e.k === 'msg' && e.text.includes(text));

/** a free bay for the player to take (not one an NPC driver is pulling into) */
function freeBay(g: Game) {
  const b = g.bays.find((q) => !q.gone && !q.by && !(q as unknown as { claim: unknown }).claim);
  expect(b).toBeTruthy();
  return b!;
}

describe('Parkovací hon', () => {
  it('needs a car', () => {
    const s = setupMini(1);
    const p = addPlayer(s.sim, 'kamenne');
    expect(s.mini.start(p, 'parking')).toBeNull();
    expect(messages(s.priv, p.id).at(-1)).toContain('potrebuješ auto');
  });

  for (const at of ['main', 'kamenne', 'blumental']) {
    it(`lays out a zone of connected streets near ${at}, with bays at the kerb clear of walls`, () => {
      const { s, p, g } = solo(at);
      const w = s.sim.world;
      const z = g.zone;
      // a loop a car can drive round: each link starts where the last one ended, back to the first
      z.links.forEach((l, i) => {
        const next = z.links[(i + 1) % z.links.length];
        expect(next.fwd ? next.edge.a : next.edge.b).toBe(l.to);
        expect(l.fwd ? l.edge.blockedF : l.edge.blockedR).toBeFalsy();
      });
      expect(z.len).toBeGreaterThan(150);
      expect(dist(z.cx, z.cy, p.ped.x, p.ped.y)).toBeLessThan(600);
      expect(g.bays.length).toBe(5);
      for (const b of g.bays) {
        const l = z.links[b.li];
        // at the right-hand kerb of its street: half a bay in from the edge of the carriageway
        const seg = w.car.segmentAt(b.x, b.y, 8)!;
        expect(seg).toBeTruthy();
        expect(Math.abs(seg.d - (l.edge.width / 2 - 1.2))).toBeLessThan(0.4);
        // clear of walls and buildings, on the ground
        const fx = Math.cos(b.a), fy = Math.sin(b.a);
        for (const o of [-1.9, 0, 1.9]) expect(w.collideCircle(b.x + fx * o, b.y + fy * o, 0.9, 0)).toBeNull();
        for (const [u, v] of [[2.6, 1.2], [2.6, -1.2], [-2.6, 1.2], [-2.6, -1.2]]) expect(w.insideBuilding(b.x + fx * u - fy * v, b.y + fy * u + fx * v)).toBe(false);
        expect(w.onBridge(b.x, b.y)).toBe(false);
        // not on a pedestrian crossing
        const cross = w.data.crossings ?? [];
        for (let i = 0; i < cross.length; i += 4) expect(dist(cross[i], cross[i + 1], b.x, b.y)).toBeGreaterThan(5);
      }
      for (let i = 0; i < g.bays.length; i++) for (let j = i + 1; j < g.bays.length; j++) expect(dist(g.bays[i].x, g.bays[i].y, g.bays[j].x, g.bays[j].y)).toBeGreaterThan(5.2);
      // on screen: the zone, a blue rectangle for each bay, the scan car, the way to a free bay
      run(s.sim, 0.3);
      const st = lastMini(s.priv, p.id)!;
      const marks = st.marks ?? [];
      expect(marks.some((m) => m.poly && m.poly.length >= 6)).toBe(true);
      expect(marks.filter((m) => m.w && m.h).length).toBe(5);
      expect(marks.find((m) => m.icon === '🔍')?.e).toBe(g.scan.id);
      expect(marks.filter((m) => m.arrow).length).toBe(1);
      expect(st.goal).toContain('box');
    });
  }

  it('NPC drivers circle the zone and take bays', () => {
    const { s, g } = solo('kamenne');
    run(s.sim, 30);
    const taken = g.bays.filter((b) => b.by && g.rivals.some((r) => r.v === b.by && r.state === 'parked'));
    expect(taken.length).toBeGreaterThanOrEqual(2);
    // standing still in the bay, as a parked car
    for (const b of taken) {
      expect(b.by!.parked).toBe(true);
      expect(dist(b.by!.x, b.by!.y, b.x, b.y)).toBeLessThan(0.5);
    }
  });

  it('the scan car passes a car in a paid bay, and fines one in a bay without a ticket', () => {
    const { s, p, car, g } = solo('kamenne');
    const b = freeBay(g);
    parkIn(car, b);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.act).toBe('Zaplatiť v appke (€2)');
    const money = p.profile.money;
    s.mini.act(p);
    expect(p.profile.money).toBe(money - 2);
    // a player's car in a bay is a parked car: traffic drives round it
    run(s.sim, 0.1);
    expect(car.parked).toBe(true);
    let at = Infinity;
    expect(runUntil(s, 120, (fresh) => (said(fresh, p.id, 'Sken OK') ? ((at = dist(g.scan.x, g.scan.y, car.x, car.y)), true) : false))).toBe(true);
    expect(at).toBeLessThanOrEqual(15);
    expect(g.st.get(p.id)!.ok).toBe(1);
    // the ticket was for one sweep: standing there without paying again is a fine next time
    expect(runUntil(s, 150, (fresh) => said(fresh, p.id, 'POKUTA!'))).toBe(true);
    const st = g.st.get(p.id)!;
    expect(st.fines).toBe(1);
    // (unless the city repainted the bay in between: then it's no longer a bay at all)
    expect(messages(s.priv, p.id).some((m) => m.includes('Nezaplatené!') || m.includes('Nestojíš v boxe'))).toBe(true);
  });

  it('with empty pockets the app puts the ticket on the tab: it comes off the pay', () => {
    const s = setupMini(3);
    const p = addPlayer(s.sim, 'kamenne', 'A', 0);
    const car = inCar(s.sim, p);
    startLive(s, p, 'parking');
    const g = game(s, p);
    parkIn(car, freeBay(g));
    run(s.sim, 0.3);
    s.mini.act(p);
    expect(p.profile.money).toBe(0);
    expect(messages(s.priv, p.id).at(-1)).toContain('na dlh');
    expect(runUntil(s, 120, (fresh) => said(fresh, p.id, 'Sken OK'))).toBe(true);
    expect((g.st.get(p.id) as unknown as { tab: number }).tab).toBe(2);
    // what the round pays so far: the sweep got through, less the ticket on the tab (40 − 2)
    expect((g as unknown as { payOf(s: unknown, f: boolean): number }).payOf(g.st.get(p.id), false)).toBe(38);
  });

  it('fines a car standing in the zone outside a bay when the scan car comes by', () => {
    const { s, p, car, g } = solo('blumental');
    // at the kerb just behind where the scan car waits (too near the junction for a bay): it's
    // passed as the sweep sets off
    const l = g.zone.links[g.zone.links.length - 1];
    const q = along(linkPoints(l, l.edge.width / 2 - 1.2), -3);
    parkIn(car, q);
    let at = Infinity;
    expect(runUntil(s, 90, (fresh) => (said(fresh, p.id, 'POKUTA!') ? ((at = dist(g.scan.x, g.scan.y, car.x, car.y)), true) : false))).toBe(true);
    expect(g.sweeping).toBe(true);
    expect(at).toBeLessThanOrEqual(15);
    expect(messages(s.priv, p.id).at(-1)).toContain('Nestojíš v boxe');
    expect(s.priv.some(([id, e]) => id === p.id && e.k === 'style' && e.label === 'POKUTA!')).toBe(true);
  });

  it('two fines and you are out: alone, that ends the round with nothing for it', () => {
    const { s, p, g } = solo('main');
    expect(runUntil(s, 260, () => s.mini.roundOf(p)?.phase === 'done')).toBe(true);
    expect(g.st.get(p.id)!.fines).toBe(2);
    expect(g.sweep).toBe(2);
    expect(messages(s.priv, p.id).some((m) => m.includes('vypadol si z hry'))).toBe(true);
    expect(lastMini(s.priv, p.id)!.result!.pay).toBe(0);
    expect(miniPay(s.priv, p.id)).toBe(0);
  });

  it('a round in paid bays pays every sweep, and the city repaints bays after each one', () => {
    const { s, p, car, g } = solo('kamenne', 5);
    let gone = 0;
    const done = runUntil(s, 330, () => {
      const st = g.st.get(p.id)!;
      if (!st.out && !g.sweeping && !g.bays.some((b) => !b.gone && b.by === car)) {
        const b = g.bays.find((q) => !q.gone && !q.by && !(q as unknown as { claim: unknown }).claim);
        if (b) parkIn(car, b);
      }
      if (lastMini(s.priv, p.id)?.act) s.mini.act(p);
      gone = g.bays.filter((b) => b.gone).length;
      return s.mini.roundOf(p)?.phase === 'done';
    });
    expect(done).toBe(true);
    const st = g.st.get(p.id)!;
    // five bays at first, one fewer after each sweep but the last
    expect(g.bays.length).toBe(5);
    expect(gone).toBe(g.sweep - 1);
    expect(st.ok).toBe(g.sweep);
    expect(st.fines).toBe(0);
    const pay = g.sweep * 40 + 80;
    expect(lastMini(s.priv, p.id)!.result).toMatchObject({ pay });
    expect(miniPay(s.priv, p.id)).toBe(pay);
    // the repainted bays show as "zákaz státia" while it's on (the view of the last live state)
  });

  it('with others: everyone hunts the same bays, and the last one standing wins', () => {
    const s = setupMini(4, 'server');
    const a = addPlayer(s.sim, 'kamenne', 'Fero', 200);
    const b = addPlayer(s.sim, 'kamenne', 'Jana', 200);
    const ca = inCar(s.sim, a);
    const cb = inCar(s.sim, b, 12);
    const r = s.mini.start(a, 'parking')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = game(s, a);
    expect(r.phase).toBe('live');
    // two players and three bays more than them
    expect(g.bays.length).toBe(5);
    // Fero parks and pays before every sweep; Jana drives off across town and stays there
    const w = s.sim.world;
    const far = w.car.nearest(g.zone.cx + 450, g.zone.cy, 300);
    parkIn(cb, { x: w.car.nx(far), y: w.car.ny(far), a: 0 });
    let first = 0;
    const done = runUntil(s, 260, () => {
      if (!g.sweeping && !g.bays.some((q) => !q.gone && q.by === ca)) {
        const q = g.bays.find((x) => !x.gone && !x.by && !(x as unknown as { claim: unknown }).claim);
        if (q) parkIn(ca, q);
      }
      if (lastMini(s.priv, a.id)?.act) s.mini.act(a);
      if (!first && g.st.get(b.id)!.fines) first = g.sweep;
      return r.phase === 'done';
    });
    expect(done).toBe(true);
    expect(first).toBe(1);
    expect(g.st.get(b.id)!.out).toBe(true);
    // over as soon as Jana was out: Fero is the last one standing
    expect(g.sweep).toBe(2);
    expect(lastMini(s.priv, a.id)!.result!.place).toBe(1);
    expect(lastMini(s.priv, b.id)!.result!.place).toBe(2);
    expect(miniPay(s.priv, a.id)).toBe(2 * 40 + 80 + 60);
    expect(miniPay(s.priv, b.id)).toBe(0);
    expect(messages(s.priv, a.id)).toContain('Jana dostal druhú pokutu a vypadol!');
    expect(s.globals.find((e) => e.k === 'miniResult')).toMatchObject({ kind: 'parking', winner: 'Fero', n: 2 });
  });

  it('the scan car and the NPC drivers go when the round is over, and the player\'s car is theirs again', () => {
    const { s, p, car, g } = solo('kamenne');
    const b = freeBay(g);
    parkIn(car, b);
    run(s.sim, 25);
    expect(car.parked).toBe(true);
    const ours = [g.scan, ...g.rivals.map((r) => r.v)];
    expect(ours.length).toBeGreaterThanOrEqual(3);
    for (const v of ours) expect(s.sim.vehicles).toContain(v);
    s.mini.leave(p);
    for (const v of ours) expect(s.sim.vehicles).not.toContain(v);
    expect(s.sim.vehicles.filter((v) => v.mission).length).toBe(0);
    expect(car.parked).toBe(false);
    expect(s.sim.vehicles).toContain(car);
    // and after a round that ran to its end, the same
    const t = solo('blumental', 7);
    expect(runUntil(t.s, 260, () => t.s.mini.roundOf(t.p)?.phase === 'done')).toBe(true);
    run(t.s.sim, DONE_S + 0.5);
    expect(t.s.mini.all.length).toBe(0);
    expect(t.s.sim.vehicles.filter((v) => v.mission).length).toBe(0);
  });
});
