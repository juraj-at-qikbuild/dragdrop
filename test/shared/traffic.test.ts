import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { linkPoints, type Link } from '../../src/shared/world/Graph';
import { MARK_BUS_STOP, MARK_STOP, type Mark } from '../../src/shared/world/TrafficLights';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import type { World } from '../../src/shared/world/World';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });
/** no NPCs of its own: just the cars a test puts down */
const EMPTY = { ...SERVER_CAPS, traffic: 0, parked: 0, peds: 0, trams: 0, police: 0 };

function look(p: SimPlayer) {
  const f = p.focus();
  Object.assign(p.observer, { fx: f.x, fy: f.y, cx: f.x, cy: f.y, hw: 30, hh: 18 });
}

/** a sim with nothing in it but a player watching (x, y) from somewhere out of the traffic's way */
function emptySim(x: number, y: number, seed = 1) {
  const sim = new Sim(loadWorld(), { rng: new Rng(seed), caps: EMPTY });
  const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: x + 400, y: y + 400 });
  Object.assign(p.observer, { fx: x, fy: y, cx: x, cy: y, hw: 30, hh: 18 });
  return sim;
}

/** every drivable link of the car graph */
function links(w: World): Link[] {
  const out: Link[] = [];
  for (const e of w.car.edges) {
    if (e.oneway !== -1 && !e.blockedF) out.push({ edge: e, fwd: true, to: e.b });
    if (e.oneway !== 1 && !e.blockedR) out.push({ edge: e, fwd: false, to: e.a });
  }
  return out;
}

/** how far along `link` (from its start) the point (x, y) lies, for a straight-ish link */
function along(link: Link, x: number, y: number) {
  const p = linkPoints(link);
  const dx = p[p.length - 2] - p[0], dy = p[p.length - 1] - p[1], L = Math.hypot(dx, dy);
  return ((x - p[0]) * dx + (y - p[1]) * dy) / L;
}

/** a link whose first mark of kind `kind` lies `min`..`max` m along it, with no lights on it */
function linkWithMark(w: World, kind: number, min: number, max: number): { link: Link; mark: Mark } | null {
  for (const link of links(w)) {
    if (link.edge.cls > 5 || w.lights.forLink(link).length) continue;
    const ms = w.marks.forLink(link);
    if (!ms.length || ms[0].kind !== kind) continue;
    const s = along(link, ms[0].x, ms[0].y);
    const p = linkPoints(link);
    // straight enough that `along` means something
    const chord = Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]);
    if (s > min && s < max && chord > link.edge.len * 0.97) return { link, mark: ms[0] };
  }
  return null;
}

const gapTo = (v: Vehicle, m: Mark) => (m.x - v.x) * m.ux + (m.y - v.y) * m.uy - v.spec.length / 2;

describe('traffic', () => {
  it('stops at a stop sign, then drives on', () => {
    const w = loadWorld();
    const found = linkWithMark(w, MARK_STOP, 25, 200);
    expect(found).not.toBeNull();
    const { link, mark } = found!;
    const sim = emptySim(mark.x, mark.y);
    const v = sim.ai.spawnOnLink('sedan', link, 'traffic')!;
    expect(v).toBeTruthy();
    let stopped = false, passed = false, top = 0;
    for (let t = 0; t < 40 && !passed; t += 0.05) {
      sim.step(0.05);
      top = Math.max(top, v.speed);
      const gap = gapTo(v, mark);
      if (gap < 4 && gap > -1.5 && v.speed < 0.6) stopped = true;
      if (gap < -3) passed = true;
    }
    expect(top).toBeGreaterThan(3);
    expect(stopped).toBe(true);
    expect(passed).toBe(true);
  });

  it('a bus pulls up at its stop for a few seconds, other traffic drives past it', () => {
    const w = loadWorld();
    const found = linkWithMark(w, MARK_BUS_STOP, 30, 250);
    expect(found).not.toBeNull();
    const { link, mark } = found!;
    const sim = emptySim(mark.x, mark.y, 2);
    const bus = sim.ai.spawnOnLink('bus', link, 'traffic')!;
    expect(bus).toBeTruthy();
    let dwell = 0, left = false;
    for (let t = 0; t < 60 && !left; t += 0.05) {
      sim.step(0.05);
      const gap = gapTo(bus, mark);
      if (Math.abs(gap) < 3 && bus.speed < 0.5) dwell += 0.05;
      if (gap < -4) left = true;
    }
    expect(dwell).toBeGreaterThan(3.5);
    expect(left).toBe(true);
    // a car doesn't stop there
    const sim2 = emptySim(mark.x, mark.y, 3);
    const car = sim2.ai.spawnOnLink('sedan', link, 'traffic')!;
    let carStopped = false;
    for (let t = 0; t < 30; t += 0.05) {
      sim2.step(0.05);
      const gap = gapTo(car, mark);
      if (Math.abs(gap) < 3 && car.speed < 0.5) carStopped = true;
      if (gap < -4) break;
    }
    expect(carStopped).toBe(false);
  });

  it('pulls out round a car parked in its lane and gets past without touching it', () => {
    const w = loadWorld();
    // a long straight two-way street, nothing on it
    const link = links(w).find((l) => {
      const e = l.edge;
      if (e.oneway || e.cls !== 5 || e.width < 7 || e.len < 90 || w.lights.forLink(l).length || w.marks.forLink(l).length) return false;
      const p = linkPoints(l);
      return Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) > e.len * 0.99;
    })!;
    expect(link).toBeTruthy();
    const pk = linkPoints(link, link.edge.width / 2 - 1);
    const dx = pk[pk.length - 2] - pk[0], dy = pk[pk.length - 1] - pk[1], L = Math.hypot(dx, dy);
    const px = pk[0] + (dx / L) * 45, py = pk[1] + (dy / L) * 45;
    const sim = emptySim(px, py, 4);
    const parked = new Vehicle('sedan', px, py, Math.atan2(dy, dx), '#888888');
    parked.parked = true;
    sim.addVehicle(parked);
    const v = sim.ai.spawnOnLink('hatch', link, 'traffic')!;
    expect(v).toBeTruthy();
    const h0 = v.health, hp = parked.health;
    let past = false;
    for (let t = 0; t < 40 && !past; t += 0.05) {
      sim.step(0.05);
      if (along(link, v.x, v.y) > 45 + 6) past = true;
    }
    expect(past).toBe(true);
    expect(v.health).toBe(h0);
    expect(parked.health).toBe(hp);
    expect(Math.hypot(parked.x - px, parked.y - py)).toBeLessThan(0.2);
  });

  it('keeps moving through a busy neighbourhood: no gridlock, nobody stuck for a minute', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(19) });
    const l = sim.world.landmark('president');
    const s = sim.world.walkableNear(l.x, l.y);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: s.x, y: s.y });
    look(p);
    sim.prewarm(p);
    const still = new Map<Vehicle, number>();
    let speed = 0, samples = 0, stuck = 0;
    for (let t = 0, i = 0; t < 120; t += 0.05, i++) {
      sim.step(0.05);
      if (i % 20) continue;
      for (const [v, d] of sim.ai.drivers) {
        if (d.mode !== 'traffic' || v.wrecked || !v.driver) continue;
        speed += Math.abs(v.fwdSpeed);
        samples++;
        if (v.speed > 0.3) still.delete(v);
        else if (still.set(v, (still.get(v) ?? 0) + 1).get(v) === 60 && d.wedged < 3) stuck++;
      }
    }
    expect(samples).toBeGreaterThan(2000);
    expect(speed / samples).toBeGreaterThan(3);
    expect(stuck).toBe(0);
  }, 60_000);
});
