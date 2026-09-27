// Buildings are solid, and nobody ends up inside one (drawn on its roof, with its walls holding them
// in): not by running into a wall on a slow frame, not by walking on out of the end of a passage,
// not by getting out of a car pressed against a wall, not by being respawned; and anyone who does
// get in some other way is put straight back outside. Checked on the real map.
import { describe, expect, it } from 'vitest';
import { Ped } from '../../src/shared/entities/Ped';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { pointInRings, segDist2 } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

/** inside a solid building and not in a passage through it: somewhere nobody can be */
function walledIn(x: number, y: number) {
  const w = loadWorld();
  if (!w.insideBuilding(x, y)) return false;
  for (const ps of w.data.passages ?? [])
    for (let k = 0; k < ps.p.length - 2; k += 2) if (segDist2(x, y, ps.p[k], ps.p[k + 1], ps.p[k + 2], ps.p[k + 3]) < (ps.w / 2) ** 2) return false;
  return true;
}

/** Every outline edge (at least `min` m long) of the solid buildings within `radius` of the main
 *  square: its midpoint, its outward normal, its direction and its building's rings. */
function facades(radius: number, min: number) {
  const w = loadWorld();
  const main = w.landmark('main');
  const out: { mx: number; my: number; nx: number; ny: number; ux: number; uy: number; rings: Float32Array[] }[] = [];
  for (const b of w.buildings) {
    if (!b.solid || Math.hypot(b.cx - main.x, b.cy - main.y) > radius) continue;
    for (const r of b.rings)
      for (let i = 0; i < r.length - 2; i += 2) {
        const L = Math.hypot(r[i + 2] - r[i], r[i + 3] - r[i + 1]);
        if (L < min) continue;
        const ux = (r[i + 2] - r[i]) / L, uy = (r[i + 3] - r[i + 1]) / L;
        out.push({ mx: (r[i] + r[i + 2]) / 2, my: (r[i + 1] + r[i + 3]) / 2, nx: uy, ny: -ux, ux, uy, rings: b.rings });
      }
  }
  return out;
}

/** open ground a figure fits on at street level */
function open(x: number, y: number, r = 0.34) {
  const w = loadWorld();
  return !w.collideCircle(x, y, r, 0, false) && !w.inWater(x, y, 0) && !w.insideBuilding(x, y) && !w.onBridge(x, y) && w.tunnelDepth(x, y) < 0;
}

/** How far from (x, y) a figure can get over open ground (a flood fill over the half-metre cells it
 *  fits on), up to `max` metres. */
function reach(x: number, y: number, max: number) {
  const w = loadWorld(), c = 0.5, n = Math.ceil((2 * max) / c) + 1;
  const seen = new Uint8Array(n * n);
  const free = (i: number, j: number) => {
    const px = x - max + i * c, py = y - max + j * c;
    return !w.collideCircle(px, py, 0.34, 0, false) && !w.inWater(px, py, 0) && !walledIn(px, py);
  };
  const s = Math.round(max / c), q = [s, s];
  seen[s * n + s] = 1;
  let far = 0;
  while (q.length && far < max - 1) {
    const j = q.pop()!, i = q.pop()!;
    far = Math.max(far, Math.hypot(i * c - max, j * c - max));
    for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]])
      if (a >= 0 && b >= 0 && a < n && b < n && !seen[b * n + a]) {
        seen[b * n + a] = 1;
        if (free(a, b)) q.push(a, b);
      }
  }
  return far;
}

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });

describe('buildings', () => {
  it('the Primate’s Palace holds: running along Primaciálne námestie pressed against it never gets anyone inside', () => {
    const w = loadWorld();
    // its long facade on the square, west to east, and out of the palace
    const [ux, uy, nx, ny] = [0.899, -0.438, -0.429, -0.904];
    let steps = 0;
    for (const speed of [4.6, 7.2])
      for (const into of [0.2, 0.45, 0.8])
        for (const off of [1, 3]) {
          const p = new Ped('player', -236.7 + nx * off - ux * 2, -312.4 + ny * off - uy * 2, 1);
          const l = Math.hypot(ux - nx * into, uy - ny * into);
          const vx = ((ux - nx * into) / l) * speed, vy = ((uy - ny * into) / l) * speed;
          for (let t = 0; t < 60 / speed; t += 1 / 60) {
            p.move(1 / 60, w, vx, vy);
            w.updateLevel(p, vx, vy, p.r);
            expect(walledIn(p.x, p.y)).toBe(false);
            steps++;
          }
          // ...and brushing along it they get along it (pushing hard into it, the recesses where
          // the square's path cuts into the palace catch them)
          if (into < 0.3) expect(Math.hypot(p.x + 236.7, p.y + 312.4)).toBeGreaterThan(20);
        }
    expect(steps).toBeGreaterThan(1000);
  });

  it('running flat out into a building on a slow frame stops at its wall, not inside it', () => {
    const w = loadWorld();
    let runs = 0, inside = 0;
    for (const f of facades(250, 3)) {
      const sx = f.mx + f.nx * 1.2, sy = f.my + f.ny * 1.2;
      if (!open(sx, sy)) continue;
      // a sprint on a 50 ms frame (the longest the game steps) moves further than a figure is wide
      for (const dt of [1 / 60, 0.05])
        for (const a of [0, 0.6]) {
          const vx = (-f.nx * Math.cos(a) + f.ux * Math.sin(a)) * 7.2, vy = (-f.ny * Math.cos(a) + f.uy * Math.sin(a)) * 7.2;
          const p = new Ped('player', sx, sy, 1);
          for (let t = 0; t < 0.5; t += dt) p.move(dt, w, vx, vy);
          runs++;
          if (walledIn(p.x, p.y)) inside++;
        }
    }
    expect(runs).toBeGreaterThan(2000);
    expect(inside).toBe(0);
  });

  it('passages lead through a building or back out of it, never into it: walking on past every end and bend', () => {
    const w = loadWorld();
    let walks = 0, inside = 0;
    const walk = (x: number, y: number, dx: number, dy: number) => {
      if (walledIn(x, y) || w.collideCircle(x, y, 0.34, 0) || w.onBridge(x, y) || w.tunnelDepth(x, y) >= 0) return;
      const p = new Ped('civ', x, y, 1);
      walks++;
      for (let t = 0; t < 2; t += 1 / 60) {
        p.move(1 / 60, w, dx * 4.6, dy * 4.6);
        if (walledIn(p.x, p.y)) {
          inside++;
          return;
        }
      }
    };
    for (const ps of w.data.passages ?? []) {
      const p = ps.p, n = p.length;
      for (let k = 0; k < n; k += 2) {
        // from a little way back along the corridor, out through the round end about each vertex:
        // straight on at either end of the passage, to the outside of the bend in between
        const j = k ? k - 2 : 2;
        const L = Math.hypot(p[k] - p[j], p[k + 1] - p[j + 1]);
        if (L < 0.05) continue;
        const ax = (p[k] - p[j]) / L, ay = (p[k + 1] - p[j + 1]) / L;
        let dx = ax, dy = ay;
        if (k && k < n - 2) {
          const l = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]) || 1;
          (dx -= (p[k + 2] - p[k]) / l), (dy -= (p[k + 3] - p[k + 1]) / l);
        }
        const dl = Math.hypot(dx, dy);
        if (dl < 0.3) continue; // hardly a bend
        walk(p[k] - ax * Math.min(2, L), p[k + 1] - ay * Math.min(2, L), dx / dl, dy / dl);
      }
    }
    expect(walks).toBeGreaterThan(700);
    expect(inside).toBe(0);
  });

  it('getting out of a car parked against a wall steps out on the free side, and a carjacked driver is thrown out there too', () => {
    const w = loadWorld();
    const sim = new Sim(w, { rng: new Rng(1) });
    const me = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    let cars = 0;
    for (const f of facades(250, 7)) {
      // (a solid wall all along the car: no passage opening onto the street there)
      if (![-2, 0, 2].every((s) => walledIn(f.mx - f.nx + f.ux * s, f.my - f.ny + f.uy * s))) continue;
      // a sedan along the wall, touching it, its driver's side (and then its kerb side) against it
      for (const side of [1, -1]) {
        const x = f.mx + f.nx * 0.92, y = f.my + f.ny * 0.92;
        const v = new Vehicle('sedan', x, y, Math.atan2(f.uy, f.ux) + (side === 1 ? Math.PI : 0), '#fff');
        let clear = !w.onBridge(x, y) && w.tunnelDepth(x, y) < 0;
        for (let c = 0; c < v.circles.length; c++) if (w.collideCircle(v.circleX(c), v.circleY(c), 0.9, 0) || !open(v.circleX(c) + f.nx * 1.7, v.circleY(c) + f.ny * 1.7, 0.45)) clear = false;
        if (!clear) continue;
        cars++;
        sim.addVehicle(v);
        me.ped.x = v.x;
        me.ped.y = v.y;
        expect(sim.enterVehicle(me, v)).toBe(true);
        sim.exitVehicle(me);
        expect(walledIn(me.ped.x, me.ped.y)).toBe(false);
        // out in the street, clear of the wall
        expect((me.ped.x - f.mx) * f.nx + (me.ped.y - f.my) * f.ny).toBeGreaterThan(0.5);
        // an NPC at the wheel gets thrown out of the kerb side
        const driver = sim.addPed(new Ped('civ', v.x, v.y, 7));
        driver.vehicle = v;
        v.driver = driver;
        expect(sim.enterVehicle(me, v)).toBe(true);
        expect(walledIn(driver.x, driver.y)).toBe(false);
        sim.exitVehicle(me);
        sim.vehicles = sim.vehicles.filter((q) => q !== v);
        sim.peds = sim.peds.filter((q) => q !== driver);
      }
    }
    expect(cars).toBeGreaterThan(40);
  });

  it('getting out after crashing into a building at speed never puts anyone inside it', () => {
    const w = loadWorld();
    const sim = new Sim(w, { rng: new Rng(2) });
    const me = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    let crashes = 0;
    for (const f of facades(300, 9)) {
      for (const speed of [20, 35]) {
        // into the wall at 57°, from 7 m back
        const hx = -f.nx * Math.sin(1) + f.ux * Math.cos(1), hy = -f.ny * Math.sin(1) + f.uy * Math.cos(1);
        const v = new Vehicle('sedan', f.mx - hx * 7, f.my - hy * 7, Math.atan2(hy, hx), '#fff');
        let clear = true;
        for (let c = 0; c < v.circles.length; c++) if (w.collideCircle(v.circleX(c), v.circleY(c), 1.2, 0) || w.insideBuilding(v.circleX(c), v.circleY(c))) clear = false;
        if (!clear || w.onBridge(v.x, v.y) || w.tunnelDepth(v.x, v.y) >= 0) continue;
        crashes++;
        v.vx = hx * speed;
        v.vy = hy * speed;
        v.setControls(1, 0, false);
        for (let t = 0; t < 1.2; t += 1 / 120) v.update(1 / 120, w);
        v.setControls(0, 0, true);
        for (let t = 0; t < 1; t += 1 / 120) v.update(1 / 120, w);
        v.levelInit = true;
        sim.addVehicle(v);
        me.ped.x = v.x;
        me.ped.y = v.y;
        if (sim.enterVehicle(me, v)) sim.exitVehicle(me);
        expect(walledIn(me.ped.x, me.ped.y)).toBe(false);
        sim.vehicles = sim.vehicles.filter((q) => q !== v);
      }
    }
    expect(crashes).toBeGreaterThan(150);
  });

  it('respawns at every hospital and police station out in the open at street level, with a way to walk off', () => {
    const w = loadWorld();
    const sim = new Sim(w, { rng: new Rng(3) });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    let spots = 0;
    for (const kind of ['hospital', 'police'] as const)
      for (const poi of w.pois(kind)) {
        // die (or get busted) right there: the nearest one of them takes them in
        p.ped.x = poi.x;
        p.ped.y = poi.y;
        p.state = kind === 'hospital' ? 'wasted' : 'busted';
        sim.respawn(p);
        const { x, y } = p.ped;
        spots++;
        expect(Math.hypot(x - poi.x, y - poi.y)).toBeLessThan(120);
        expect(open(x, y, 0.45)).toBe(true);
        expect(w.spawnLevel(x, y, p.ped.r)).toBe(0);
        expect(reach(x, y, 25)).toBeGreaterThanOrEqual(24);
      }
    expect(spots).toBeGreaterThan(12);
  });

  it('what gets put down near a place (a job’s pickup at every snack bar, a respawn) is out in the open, never on a roof', () => {
    const w = loadWorld();
    const places = [...(w.data.places ?? []).filter((p) => p.k === 'food'), ...w.pois('hospital'), ...w.pois('police')];
    expect(places.length).toBeGreaterThan(400);
    for (const p of places) {
      const s = w.walkableNear(p.x, p.y);
      expect(Math.hypot(s.x - p.x, s.y - p.y)).toBeLessThan(120);
      // not in (or under) any building at all, a canopy or a passage included
      expect(w.buildings.some((b) => pointInRings(s.x, s.y, b.rings))).toBe(false);
      expect(open(s.x, s.y, 0.45)).toBe(true);
      expect(reach(s.x, s.y, 20)).toBeGreaterThanOrEqual(19);
    }
  });

  it('anyone who still ends up inside a building is put straight back out, where they got in', () => {
    const w = loadWorld();
    let tried = 0, thick = 0;
    for (const f of facades(200, 6)) {
      const ix = f.mx - f.nx * 1.5, iy = f.my - f.ny * 1.5;
      if (!walledIn(ix, iy) || !pointInRings(ix, iy, f.rings) || !open(f.mx + f.nx * 1, f.my + f.ny * 1, 0.45)) continue;
      // shoved, thrown or dropped 1.5 m in through the middle of a wall
      const p = new Ped('player', ix, iy, 1);
      p.move(1 / 60, w, 0, 0);
      tried++;
      expect(walledIn(p.x, p.y)).toBe(false);
      expect(Math.hypot(p.x - ix, p.y - iy)).toBeLessThan(4);
      // where the building is thick, that's back out through the wall they came in by
      if (![-1.5, 0, 1.5].every((s) => pointInRings(f.mx - f.nx * 3 + f.ux * s, f.my - f.ny * 3 + f.uy * s, f.rings))) continue;
      thick++;
      expect((p.x - f.mx) * f.nx + (p.y - f.my) * f.ny).toBeGreaterThan(0);
      expect(Math.hypot(p.x - f.mx, p.y - f.my)).toBeLessThan(1.5);
    }
    expect(tried).toBeGreaterThan(300);
    expect(thick).toBeGreaterThan(100);
    // someone walking through a gateway (Michalská brána) is where they should be: nobody moves them
    const q = new Ped('player', -426.5, -457, 1);
    expect(w.insideBuilding(q.x, q.y)).toBe(true);
    q.move(1 / 60, w, 0, 0);
    expect(Math.hypot(q.x + 426.5, q.y + 457)).toBeLessThan(0.01);
  });
});
