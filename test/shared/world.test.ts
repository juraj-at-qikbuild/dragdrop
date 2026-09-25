// The physical city: raised structures, passages, tunnels, walls, piers and traffic lights, checked
// against the real map with the same collision code the server and every client run.
import { describe, expect, it } from 'vitest';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { Tram } from '../../src/shared/entities/Tram';
import type { Prop } from '../../src/shared/entities/Props';
import { Sim } from '../../src/shared/sim/Sim';
import { SECONDS_PER_HOUR } from '../../src/shared/sim/Clock';
import { Rng } from '../../src/shared/util/Rng';
import { OFF_MAP, type Level } from '../../src/shared/world/World';
import { linkPoints } from '../../src/shared/world/Graph';
import { loadWorld } from './helpers';

/** Drive a sedan along waypoints (a simple follow-the-points driver), like traffic does. */
function drive(pts: number[], maxT = 60, cruise = 9) {
  const w = loadWorld();
  const v = new Vehicle('sedan', pts[0], pts[1], Math.atan2(pts[3] - pts[1], pts[2] - pts[0]), '#fff');
  v.level = w.spawnLevel(v.x, v.y, v.spec.width / 2, v.angle);
  const levels: Level[] = [v.level];
  let i = 2, t = 0, maxImpact = 0;
  const dt = 1 / 120;
  while (i < pts.length && t < maxT) {
    const dx = pts[i] - v.x, dy = pts[i + 1] - v.y;
    if (Math.hypot(dx, dy) < 3) {
      i += 2;
      continue;
    }
    let diff = Math.atan2(dy, dx) - v.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    v.setControls(v.fwdSpeed < cruise ? 1 : 0, Math.max(-1, Math.min(1, diff * 2.2)), false);
    w.updateLevel(v, v.vx, v.vy, v.spec.width / 2);
    maxImpact = Math.max(maxImpact, v.update(dt, w));
    if (levels[levels.length - 1] !== v.level) levels.push(v.level);
    t += dt;
  }
  return { reached: i >= pts.length, maxImpact, levels, v };
}

/** Walk a figure along waypoints; returns whether it got through and time spent in the water. */
function walk(pts: number[], maxT = 40) {
  const w = loadWorld();
  const p = new Ped('civ', pts[0], pts[1], 1);
  let i = 2, t = 0, wet = 0;
  const dt = 1 / 60, speed = 4.6;
  while (i < pts.length && t < maxT) {
    const dx = pts[i] - p.x, dy = pts[i + 1] - p.y, d = Math.hypot(dx, dy);
    if (d < 0.8) {
      i += 2;
      continue;
    }
    p.move(dt, w, (dx / d) * speed, (dy / d) * speed);
    w.updateLevel(p, (dx / d) * speed, (dy / d) * speed, p.r);
    if (w.inWater(p.x, p.y, p.level)) wet += dt;
    t += dt;
  }
  return { reached: i >= pts.length, wet };
}

describe('World', () => {
  it('the UFO sits on the Most SNP pylon: traffic on the deck drives under it', () => {
    const w = loadWorld();
    const ufo = w.buildings.find((b) => b.kind === 5 && b.minH > 0);
    expect(ufo?.minH).toBe(85);
    expect(ufo?.solid).toBe(false);
    // both carriageways, through the pylon at 95 km/h, on the road deck (level 2: the footways
    // hang below it at level 1)
    for (const pts of [[-578.5, 560, -579, 470, -580, 440, -581, 390], [-600, 200, -592, 445, -591, 470, -589, 534]]) {
      const r = drive(pts, 20, 27);
      expect(r.reached).toBe(true);
      expect(r.maxImpact).toBe(0);
      expect(r.levels).toEqual([2]);
    }
  });

  it('Most SNP: its footway is a separate deck below the road, and people stay on it', () => {
    const w = loadWorld();
    // on the east footway beside the northbound carriageway, over the river
    const p = new Ped('civ', -582.4, 300, 1);
    p.level = w.spawnLevel(p.x, p.y, p.r);
    expect(p.level).toBe(1);
    // pushing sideways towards the road deck (and the other way, towards the river) for a while:
    // the railings hold them on the footway, dry
    for (const dir of [-1, 1]) {
      for (let t = 0; t < 3; t += 1 / 60) {
        p.move(1 / 60, w, dir * 4.6, 0.3);
        w.updateLevel(p, dir * 4.6, 0.3, p.r);
      }
      expect(p.level).toBe(1);
      expect(w.inWater(p.x, p.y, p.level)).toBe(false);
    }
  });

  it('fountains are basins you can see and can’t drive or walk through: the Roland fountain', () => {
    const w = loadWorld();
    const [fx, fy, rad] = [-322.4, -261.6, 3.8];
    // it's drawn as water (it used to be a hole in the square's paving)
    expect(w.data.areas.water.some((rings) => Math.hypot(rings[0][0] - fx, rings[0][1] - fy) < rad + 1)).toBe(true);
    const r = drive([fx - 25, fy, fx + 25, fy], 6, 10);
    expect(r.reached).toBe(false);
    expect(r.maxImpact).toBeGreaterThan(5);
    const p = new Ped('civ', fx, fy - 12, 1);
    for (let t = 0; t < 5; t += 1 / 60) p.move(1 / 60, w, 0, 4.6);
    expect(Math.hypot(p.x - fx, p.y - fy)).toBeGreaterThan(rad - 0.5);
    // and the game starts next to it, not in it
    const sim = new Sim(w, { rng: new Rng(1) });
    const me = sim.addPlayer({ nick: 'A', profile: { money: 0, done: [], found: [], cumils: [] }, kinematic: false });
    expect(w.collideCircle(me.ped.x, me.ped.y, 0.45, 0, false)).toBeNull();
  });

  it('bollards close a street to cars, not to people: Uršulínska at Primaciálne námestie', () => {
    const r = drive([-229.7, -393.1, -224.7, -385.3, -207.5, -364.9, -200, -356], 8, 8);
    expect(r.reached).toBe(false);
    expect(r.maxImpact).toBeGreaterThan(3);
    expect(walk([-224.7, -385.3, -207.5, -364.9, -200, -356]).reached).toBe(true);
    // traffic can't route through (the car graph is cut there), police routes avoid it
    const w = loadWorld();
    const n = w.car.nearest(-207.5, -364.9, 3);
    expect(n).toBe(-1);
    expect(w.ped.edges.filter((e) => e.noCars).length).toBeGreaterThan(100);
  });

  it('lanes keep clear of the buildings: two-way traffic on narrow Lýcejná drives through without scraping', () => {
    const w = loadWorld();
    const edge = w.car.edges.find((e) => e.name >= 0 && w.names[e.name] === 'Lýcejná' && e.len > 50)!;
    expect(edge.laneF!).toBeLessThan(edge.width / 4);
    for (const fwd of [true, false]) {
      const pts = linkPoints({ edge, fwd, to: fwd ? edge.b : edge.a }, fwd ? edge.laneF : edge.laneR);
      const r = drive(pts, 30, 8);
      expect(r.reached).toBe(true);
      expect(r.maxImpact).toBe(0);
    }
  });

  it('through traffic keeps out of cul-de-sacs and off the edge of the map', () => {
    const w = loadWorld();
    const depth = w.car.depth!;
    const at = (x: number, y: number) => depth[w.car.nearest(x, y, 30)];
    expect(at(-1443, -325)).toBeGreaterThan(0); // the end of Slepá ("dead-end street")
    expect(at(-625, -192)).toBe(0); // Staromestská
    expect(at(-616, 3)).toBe(0); // Most SNP
    const B = w.bounds;
    for (let i = 0; i < depth.length; i++) {
      const out = w.car.nx(i) < B.x0 || w.car.nx(i) > B.x1 || w.car.ny(i) < B.y0 || w.car.ny(i) > B.y1;
      if (out) expect(depth[i]).toBe(OFF_MAP);
    }
  });

  it('streets through buildings are open: Michalská brána, Leopoldova brána, Žižkova', () => {
    expect(walk([-429, -407, -426, -446, -425, -453, -428, -461, -436, -482, -437, -487, -435, -489, -428, -493, -420, -498]).reached).toBe(true);
    expect(walk([-976, -36, -968, -35.5, -946, -34.5, -938, -34]).reached).toBe(true);
    const r = drive([-1250, 17, -1258, 14, -1267, 9, -1296, -5, -1306, -10, -1327, -21, -1350, -32]);
    expect(r.reached).toBe(true);
    expect(r.maxImpact).toBe(0);
  });

  it('Suché mýto runs under Hodžovo námestie: a car goes underground and comes back up', () => {
    const r = drive([-531, -629, -493, -662, -437, -706, -362, -764, -313, -808, -280, -840]);
    expect(r.reached).toBe(true);
    expect(r.levels).toEqual([0, -1, 0]);
    expect(r.maxImpact).toBe(0);
  });

  it('trams run through the tunnel under the castle hill instead of turning back', () => {
    const w = loadWorld();
    for (const [x, y] of [[-747.5, -343.3], [-1498.9, -102.1]]) {
      const g = w.tram;
      const n = g.nearest(x, y, 5);
      const link = g.out[n].find((l) => Math.hypot(g.nx(l.to) - x, g.ny(l.to) - y) > 50) ?? g.out[n][0];
      const t = new Tram(g, link, new Rng(1), w.tramStops);
      t.level = w.spawnLevel(t.x, t.y, 1.2, t.angle);
      const levels: Level[] = [t.level];
      for (let s = 0; s < 95; s += 1 / 30) {
        t.update(1 / 30);
        w.updateLevel(t, Math.cos(t.angle) * t.speed, Math.sin(t.angle) * t.speed, 1.2, false);
        if (levels[levels.length - 1] !== t.level) levels.push(t.level);
      }
      expect(levels).toEqual([-1, 0]);
      // it came out of the other portal, the full tunnel length away
      expect(Math.hypot(t.x - x, t.y - y)).toBeGreaterThan(600);
    }
  });

  it('a car blowing up in the tunnel kills the people beside it, not the ones on the square above', () => {
    const w = loadWorld();
    const sim = new Sim(w, { rng: new Rng(12) });
    const [x, y] = [-403.5, -740]; // in Suché mýto, under Hodžovo námestie
    expect(w.tunnelDepth(x, y)).toBeGreaterThan(6);
    const car = sim.addVehicle(new Vehicle('sedan', x, y, -0.66, '#fff'));
    const inside = sim.addPed(new Ped('civ', x - 2, y - 1, 1));
    const above = sim.addPed(new Ped('civ', x + 2, y + 1, 2));
    car.level = inside.level = -1;
    sim.wreck(car);
    expect(inside.dead).toBe(true);
    expect(above.dead).toBe(false);
  });

  it('walls, fences and hedges stop people and cars', () => {
    const w = loadWorld();
    for (const kind of [0, 1, 3, 4]) {
      let best: number[] | null = null, bestL = 6;
      for (const b of w.data.barriers ?? []) {
        if (b.k !== kind) continue;
        for (let i = 0; i < b.p.length - 2; i += 2) {
          const L = Math.hypot(b.p[i + 2] - b.p[i], b.p[i + 3] - b.p[i + 1]);
          const mx = (b.p[i] + b.p[i + 2]) / 2, my = (b.p[i + 1] + b.p[i + 3]) / 2;
          const B = w.bounds;
          if (mx < B.x0 + 20 || mx > B.x1 - 20 || my < B.y0 + 20 || my > B.y1 - 20) continue;
          if (L > bestL && !w.insideBuilding(mx + 3, my) && !w.insideBuilding(mx - 3, my) && !w.inWater(mx, my)) (bestL = L), (best = b.p.slice(i, i + 4));
        }
      }
      expect(best).not.toBeNull();
      const [ax, ay, bx, by] = best!;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, nx = -(by - ay) / bestL, ny = (bx - ax) / bestL;
      const p = new Ped('civ', mx - nx * 3, my - ny * 3, 1);
      for (let t = 0; t < 4; t += 1 / 60) p.move(1 / 60, w, nx * 4.6, ny * 4.6);
      expect((p.x - mx) * nx + (p.y - my) * ny).toBeLessThan(0);
      const r = drive([mx - nx * 8, my - ny * 8, mx + nx * 8, my + ny * 8], 3, 15);
      expect(r.reached).toBe(false);
      expect(r.maxImpact).toBeGreaterThan(5);
    }
  });

  it('no wall, fence, tree trunk, bollard or fountain stands in a lane or on a walking line', () => {
    const w = loadWorld();
    let blocked = 0;
    /** the line `off` metres right of polyline p (as the AI follows it), sampled every 2 m, `skip`
     *  m short of either end (at junctions people and cars turn the corner before its end) */
    const check = (p: Float32Array, off: number, radius: number, skip: number) => {
      const pts = linkPoints({ edge: { p } as never, fwd: true, to: 0 }, off);
      let total = 0;
      for (let i = 0; i < pts.length - 2; i += 2) total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
      let s = 0;
      for (let i = 0; i < pts.length - 2; i += 2) {
        const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
        for (let d = 1; d < L; d += 2) {
          const x = pts[i] + ((pts[i + 2] - pts[i]) * d) / L, y = pts[i + 1] + ((pts[i + 3] - pts[i + 1]) * d) / L;
          if (s + d < skip || s + d > total - skip || w.onBridge(x, y) || w.tunnelDepth(x, y) >= 0) continue;
          w.forWalls(x, y, radius, (ax, ay, bx, by, ht, flags) => {
            // low obstacles: walls, fences, hedges, trunks, posts, rims (buildings aren't what this checks)
            if (!(flags & 2) || flags & 4) return;
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
            let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
            t = Math.max(0, Math.min(1, t));
            // (people brush past a slim bollard: a few centimetres don't count)
            if (Math.hypot(x - ax - dx * t, y - ay - dy * t) < radius + ht - 0.15 - (flags & 8 ? 0.1 : 0)) blocked++;
          });
        }
        s += L;
      }
    };
    // every lane traffic drives (both ways), every walking line people use (both sides)
    for (const e of w.car.edges) {
      if (e.oneway !== -1 && !e.blockedF) check(e.p, e.laneF ?? 0, 0.9, 3);
      if (e.oneway !== 1 && !e.blockedR) check(e.p, -(e.laneR ?? 0), 0.9, 3);
    }
    for (const e of w.ped.edges) {
      if (e.noWalk) continue;
      check(e.p, e.walkR ?? 0, 0.34, 2);
      check(e.p, -(e.walkL ?? 0), 0.34, 2);
    }
    expect(blocked).toBe(0);
  });

  it('piers and pontoons are dry, the river around them is not', () => {
    const w = loadWorld();
    expect(w.inWater(-670, 185, 0)).toBe(false); // on the LOD-P-37 pontoon
    expect(w.inWater(-670, 200, 0)).toBe(true); // beside it
    expect(walk([-672, 150, -672.1, 158.3, -673.7, 178.9, -673.5, 184, -700, 182.5, -640, 185]).wet).toBe(0);
  });

  it('police roadblocks and spike strips go on the street, never on a bridge deck or in a tunnel', () => {
    const w = loadWorld();
    const seen = new Set<Prop>();
    // a wanted player racing for Most SNP (from either bank), Most Apollo and the Suché mýto tunnel
    for (const [x, y, a] of [[-600, -150, Math.PI / 2], [-580, 800, -Math.PI / 2], [1250, -120, Math.PI / 2], [-560, -600, -0.75]]) {
      const sim = new Sim(w, { rng: new Rng(11) });
      const p = sim.addPlayer({ nick: 'A', profile: { money: 0, done: [], found: [], cumils: [] }, kinematic: true, x, y });
      const car = new Vehicle('sedan', x, y, a, '#fff');
      sim.addVehicle(car);
      expect(sim.enterVehicle(p, car)).toBe(true);
      sim.setWanted(p, 4);
      for (let t = 0; t < 20; t += 0.05) {
        Object.assign(car, { x, y, angle: a, vx: Math.cos(a) * 12, vy: Math.sin(a) * 12 });
        Object.assign(p.observer, { fx: x, fy: y, cx: x, cy: y, hw: 30, hh: 18 });
        sim.step(0.05);
        for (const pr of sim.props) seen.add(pr);
      }
    }
    expect(seen.size).toBeGreaterThan(4);
    // they stand on level 0: on a deck they'd be under it, in a tunnel on the street above it
    for (const pr of seen) expect(w.onBridge(pr.x, pr.y) || w.tunnelDepth(pr.x, pr.y) >= 0).toBe(false);
  });

  it('traffic lights: real junctions, a cycle that fits the game day, and traffic that stops on red', () => {
    const w = loadWorld();
    expect(w.lights.lines.length).toBeGreaterThan(150);
    // a whole number of cycles per 24 in-game hours, so the phase never jumps at midnight
    for (const l of w.lights.lines.slice(0, 20)) {
      const day = 24 * SECONDS_PER_HOUR;
      for (const t of [0, 7, 19, 33]) expect(w.lights.state(l, t)).toBe(w.lights.state(l, t + day));
    }
    // around Hodžovo námestie, some traffic waits at a red stop line
    const sim = new Sim(w, { rng: new Rng(3) });
    const p = sim.addPlayer({ nick: 'A', profile: { money: 0, done: [], found: [], cumils: [] }, kinematic: false, x: -330, y: -800 });
    Object.assign(p.observer, { fx: -330, fy: -800, cx: -330, cy: -800, hw: 30, hh: 18 });
    sim.prewarm(p);
    let waited = 0;
    for (let s = 0; s < 60; s += 0.05) {
      sim.step(0.05);
      for (const [v, d] of sim.ai.drivers) {
        const l = d.stops[0];
        if (d.mode !== 'traffic' || !l || v.speed > 0.5) continue;
        const gap = (l.x - v.x) * l.ux + (l.y - v.y) * l.uy - v.spec.length / 2;
        if (gap > -1 && gap < 4 && w.lights.state(l, sim.clock.time * SECONDS_PER_HOUR) === 2) waited++;
      }
    }
    expect(waited).toBeGreaterThan(0);
  });
});
