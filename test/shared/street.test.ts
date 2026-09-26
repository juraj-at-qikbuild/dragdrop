// The street in detail: traffic islands, speed bumps, lift gates, bridge piers, signs, the city's
// boroughs and squares, 3D building parts and the landmarks, on the real map.
import { describe, expect, it } from 'vitest';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { VehiclePhysics } from '../../src/shared/sim/Physics';
import { loadWorld } from './helpers';

const DT = 1 / 120;

/** Roll a sedan from (x, y) heading `a` at `speed` for `t` seconds, holding that speed with the
 *  throttle (0 = coast); returns the car and what it met. */
function roll(x: number, y: number, a: number, speed: number, t: number, hold = true) {
  const w = loadWorld();
  const v = new Vehicle('sedan', x, y, a, '#fff');
  v.vx = Math.cos(a) * speed;
  v.vy = Math.sin(a) * speed;
  const phys = new VehiclePhysics();
  let minSpeed = speed, air = 0;
  for (let s = 0; s < t; s += DT) {
    v.setControls(hold && v.fwdSpeed < speed ? 1 : 0, 0, false);
    phys.step(DT, [v], [], w, {});
    minSpeed = Math.min(minSpeed, v.speed);
    air = Math.max(air, v.air);
  }
  return { v, minSpeed, air };
}

describe('Street', () => {
  it('traffic islands are kerbs: a car bumps up onto one, loses speed and drags across it', () => {
    const w = loadWorld();
    let tested = 0;
    for (let i = 0; i < w.islands.rings.length && tested < 3; i++) {
      const r = w.islands.rings[i];
      let cx = 0, cy = 0;
      for (let k = 0; k < r.length - 2; k += 2) (cx += r[k]), (cy += r[k + 1]);
      cx /= r.length / 2 - 1;
      cy /= r.length / 2 - 1;
      if (w.surfaceAt(cx, cy, 0) !== 'kerb') continue;
      // a clear run-up of 14 m from any side
      for (let d = 0; d < 8; d++) {
        const a = (d / 8) * Math.PI * 2;
        const sx = cx - Math.cos(a) * 14, sy = cy - Math.sin(a) * 14;
        if (w.raycast(sx, sy, cx, cy) < 1 || w.collideCircle(sx, sy, 1.2, 0) || w.onBridge(sx, sy) || w.inWater(sx, sy, 0) || w.islands.at(sx, sy, 2) >= 0) continue;
        const { v, minSpeed } = roll(sx, sy, a, 12, 1.4, false);
        expect(v.jolts).toBeGreaterThan(0);
        expect(minSpeed).toBeLessThan(11);
        tested++;
        break;
      }
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('speed bumps: gentle at walking pace, airborne at 70 km/h', () => {
    const w = loadWorld();
    const d = w.bumps.data;
    let tested = 0;
    for (let i = 0; i < w.bumps.n && tested < 2; i++) {
      if (d[i * 6 + 5] !== 0) continue;
      const bx = d[i * 6], by = d[i * 6 + 1], ux = d[i * 6 + 2], uy = d[i * 6 + 3];
      const sx = bx - ux * 10, sy = by - uy * 10, a = Math.atan2(uy, ux);
      if (w.raycast(sx, sy, bx + ux * 5, by + uy * 5) < 1 || w.collideCircle(sx, sy, 1.2, 0) || w.onBridge(sx, sy)) continue;
      const slow = roll(sx, sy, a, 4, 3);
      expect(slow.air).toBe(0);
      expect(slow.v.jolts).toBeGreaterThan(0);
      const fast = roll(sx, sy, a, 19.5, 0.7);
      expect(fast.air).toBeGreaterThan(0);
      expect(fast.v.joltK).toBeGreaterThan(0.5);
      tested++;
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('lift gates: a creeping car stops at the boom, a car ramming it snaps it', () => {
    const w = loadWorld();
    const g = w.gates;
    let tested = 0;
    for (let i = 0; i < g.n && tested < 2; i++) {
      // the boom's middle, and the way it crosses (normal to the boom)
      const mx = g.px[i] + g.ux[i] * g.len[i] * 0.5, my = g.py[i] + g.uy[i] * g.len[i] * 0.5;
      const nx = -g.uy[i], ny = g.ux[i];
      for (const side of [1, -1]) {
        const sx = mx - nx * side * 9, sy = my - ny * side * 9, a = Math.atan2(ny * side, nx * side);
        if (w.raycast(sx, sy, mx + nx * side * 6, my + ny * side * 6) < 1 || w.collideCircle(sx, sy, 1.3, 0) || w.collideCircle(mx + nx * side * 5, my + ny * side * 5, 1.3, 0)) continue;
        g.broken[i] = 0;
        const creep = roll(sx, sy, a, 1.8, 7);
        const past = (creep.v.x - mx) * nx * side + (creep.v.y - my) * ny * side;
        expect(past).toBeLessThan(0);
        expect(g.broken[i]).toBe(0);
        const ram = roll(sx, sy, a, 11, 2);
        expect(g.broken[i]).toBeGreaterThan(0);
        expect((ram.v.x - mx) * nx * side + (ram.v.y - my) * ny * side).toBeGreaterThan(2);
        g.broken[i] = 0;
        tested++;
        break;
      }
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('bridge piers stand solid in the street, not up on the deck', () => {
    const w = loadWorld();
    const s = w.data.supports ?? [];
    expect(s.length).toBeGreaterThan(5);
    let onLand = 0, solid = 0;
    for (const r of s) {
      // just outside the middle of the pier's first face (its faces are the obstacle)
      const mx = (r[0] + r[2]) / 2, my = (r[1] + r[3]) / 2, L = Math.hypot(r[2] - r[0], r[3] - r[1]) || 1;
      for (const side of [1, -1]) {
        const x = mx + (-(r[3] - r[1]) / L) * 0.3 * side, y = my + ((r[2] - r[0]) / L) * 0.3 * side;
        if (w.inWater(x, y, 0) || w.insideBuilding(x, y)) continue;
        onLand++;
        if (w.collideCircle(x, y, 0.4, 0)) solid++;
        if (w.onBridge(x, y)) expect(w.collideCircle(x, y, 0.4, 1)).toBeNull();
      }
    }
    expect(onLand).toBeGreaterThan(0);
    expect(solid).toBe(onLand);
  });

  it('stop and give-way signs and bumps are on the approaches traffic reads', () => {
    const w = loadWorld();
    expect(w.marks.signs.length).toBeGreaterThan(120);
    let bumps = 0;
    for (const e of w.car.edges) for (const fwd of [true, false]) for (const m of w.marks.forLink({ edge: e, fwd, to: fwd ? e.b : e.a })) if (m.kind >= 2) bumps++;
    expect(bumps).toBeGreaterThan(60);
  });

  it('knows where you are: boroughs, quarters and squares', () => {
    const w = loadWorld();
    const at = (id: string) => w.landmark(id);
    expect(w.district(at('main').x, at('main').y)).toBe('Staré Mesto');
    expect(w.district(at('sad').x, at('sad').y)).toBe('Petržalka');
    expect(w.district(at('nivytower').x, at('nivytower').y)).toBe('Ružinov');
    // beside the Roland fountain
    expect(w.squareAt(-322, -272)).toBe('Hlavné námestie');
    expect(w.squareAt(-322, -700)).toBeNull();
    expect(w.quarter(at('main').x, at('main').y)).toBe('Vnútorné mesto');
  });

  it('landmarks include Slavín and the Radio up the hill, and the new downtown', () => {
    const w = loadWorld();
    expect(w.landmarks.size).toBeGreaterThanOrEqual(50);
    for (const id of ['slavin', 'radio', 'radnica', 'euroveatower', 'newsnd', 'synagogue']) expect(w.landmarks.has(id)).toBe(true);
    const b = w.bounds;
    for (const l of w.landmarks.values()) expect(l.x > b.x0 && l.x < b.x1 && l.y > b.y0 && l.y < b.y1).toBe(true);
  });

  it('the cathedral is drawn as its parts: an 85 m tower with a pyramid spire', () => {
    const w = loadWorld();
    const c = w.landmark('cathedral');
    const tower = w.buildings.find((b) => b.part && b.roofShape === 4 && Math.hypot(b.cx - c.x, b.cy - c.y) < 60 && b.minH > 10);
    expect(tower).toBeDefined();
    expect(tower!.levels * 3.2 + tower!.roofH).toBeCloseTo(85, 0);
    expect(tower!.solid).toBe(false);
    // its outline is still the solid obstacle
    expect(w.insideBuilding(tower!.cx, tower!.cy)).toBe(true);
  });
});
