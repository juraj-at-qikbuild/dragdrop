import { describe, expect, it } from 'vitest';
import { MIN_INTEREST_SCORE, SPOT_KINDS, buildFeatureCtx, candidateSpots, isCourtyard, underAnyRoof, visualInterestScore } from '../../src/shared/world/spots';
import { dist } from '../../src/shared/util/math';
import { placePickups } from '../../src/shared/sim/Pickups';
import { loadWorld } from './helpers';

describe('candidateSpots', () => {
  const world = loadWorld();

  it('is deterministic for a given seed', () => {
    const a = candidateSpots(world, 30, 42);
    const b = candidateSpots(world, 30, 42);
    expect(a).toEqual(b);
  });

  it('a different seed gives a different order/mix', () => {
    const a = candidateSpots(world, 30, 42);
    const b = candidateSpots(world, 30, 7);
    expect(a).not.toEqual(b);
  });

  it('every spot is walkable, ped-reachable, and away from landmarks/Čumils', () => {
    const spots = candidateSpots(world, 60, 1);
    expect(spots.length).toBeGreaterThan(30);
    const landmarks = [...world.landmarks.values()];
    const cumils = placePickups(world).filter((p) => p.kind === 'cumil');
    for (const s of spots) {
      const w = world.walkableNear(s.x, s.y);
      expect(dist(w.x, w.y, s.x, s.y)).toBeLessThanOrEqual(1.5);
      expect(world.ped.nearest(s.x, s.y, 15)).toBeGreaterThanOrEqual(0);
      for (const l of landmarks) expect(dist(l.x, l.y, s.x, s.y)).toBeGreaterThanOrEqual(80);
      for (const c of cumils) expect(dist(c.x, c.y, s.x, s.y)).toBeGreaterThanOrEqual(80);
      expect(s.level).toBe(0);
      expect(SPOT_KINDS).toContain(s.kind);
    }
  });

  it('every spot is at least 150 m from every other spot', () => {
    const spots = candidateSpots(world, 60, 2);
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) expect(dist(spots[i].x, spots[i].y, spots[j].x, spots[j].y)).toBeGreaterThanOrEqual(150);
  });

  it('mixes kinds', () => {
    const spots = candidateSpots(world, 60, 3);
    const kinds = new Set(spots.map((s) => s.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it('spreads across the three boroughs', () => {
    const spots = candidateSpots(world, 60, 4);
    const districts = new Set(spots.map((s) => s.district));
    expect(districts).toEqual(new Set(['Staré Mesto', 'Petržalka', 'Ružinov']));
  });

  it('fills in hints (district always; quarter/street usually)', () => {
    const spots = candidateSpots(world, 60, 5);
    for (const s of spots) expect(s.district.length).toBeGreaterThan(0);
    const withQuarter = spots.filter((s) => s.quarter).length;
    const withStreet = spots.filter((s) => s.street).length;
    expect(withQuarter).toBeGreaterThan(spots.length * 0.5);
    expect(withStreet).toBeGreaterThan(spots.length * 0.5);
  });

  it('a small n still gets a mix, not just the first kind in the round-robin', () => {
    const spots = candidateSpots(world, 6, 6);
    expect(spots).toHaveLength(6);
    expect(new Set(spots.map((s) => s.kind)).size).toBeGreaterThanOrEqual(4);
  });

  it('asking for more than exist just returns as many as were found', () => {
    const spots = candidateSpots(world, 100000, 8);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.length).toBeLessThan(100000);
  });

  it('no spot is under any roof (a building really does hide its own footprint from above)', () => {
    const spots = candidateSpots(world, 100000, 9);
    expect(spots.length).toBeGreaterThan(50);
    for (const s of spots) expect(underAnyRoof(world, s.x, s.y)).toBe(false);
  });

  it("dropped 'passage': it tunnels under the building that spans it, so it never clears underAnyRoof", () => {
    expect(SPOT_KINDS).not.toContain('passage');
    // every raw passage midpoint (long enough, reasonably enclosed) is rejected on the real map
    const midpoints: { x: number; y: number }[] = [];
    for (const p of world.data.passages ?? []) {
      const pts = p.p;
      let total = 0;
      for (let i = 0; i < pts.length - 2; i += 2) total += dist(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
      if (total < 8) continue;
      let mx = 0, my = 0, n = pts.length / 2;
      for (let i = 0; i < pts.length; i += 2) (mx += pts[i]), (my += pts[i + 1]);
      midpoints.push({ x: mx / n, y: my / n }); // roughly the middle of a short, roughly-straight corridor
    }
    expect(midpoints.length).toBeGreaterThan(50); // the map really does have plenty to test against
    const underRoof = midpoints.filter((m) => underAnyRoof(world, m.x, m.y));
    expect(underRoof.length).toBeGreaterThan(midpoints.length * 0.8); // the overwhelming majority are
  });

  it('every accepted courtyard is far from any road and enclosed on most sides', () => {
    const spots = candidateSpots(world, 100000, 10).filter((s) => s.kind === 'courtyard');
    expect(spots.length).toBeGreaterThan(5);
    for (const s of spots) {
      expect(world.onCarriageway(s.x, s.y, 12)).toBe(false);
      expect(isCourtyard(world, s.x, s.y)).toBe(true);
    }
  });

  it('isCourtyard rejects a point right next to a road even when a building is close by', () => {
    // the nearest car-graph node's own position is definitionally on/at a road
    const n = world.car.nearest(0, 0);
    expect(isCourtyard(world, world.car.nx(n), world.car.ny(n))).toBe(false);
  });

  it('underAnyRoof is true inside a real building and false in the open (Hlavné námestie)', () => {
    const solid = world.buildings.find((b) => {
      if (!b.solid || b.part || b.hidden || b.rings.length !== 1) return false;
      const r = b.rings[0];
      let cx = 0, cy = 0;
      for (let i = 0; i < r.length; i += 2) (cx += r[i]), (cy += r[i + 1]);
      return underAnyRoof(world, cx / (r.length / 2), cy / (r.length / 2));
    })!;
    expect(solid).toBeTruthy();
    const main = world.landmark('main');
    expect(underAnyRoof(world, main.x, main.y)).toBe(false);
  });

  it('every accepted spot clears the visual-interest threshold', () => {
    const spots = candidateSpots(world, 100000, 11);
    const ctx = buildFeatureCtx(world);
    expect(spots.length).toBeGreaterThan(50);
    for (const s of spots) expect(visualInterestScore(world, ctx, s.x, s.y)).toBeGreaterThanOrEqual(MIN_INTEREST_SCORE);
  });

  it('visualInterestScore is low for a plain point and higher near a square (benches, paving, buildings)', () => {
    const ctx = buildFeatureCtx(world);
    const main = world.landmark('main');
    const plain = world.walkableNear(world.bounds.x0 + 40, world.bounds.y0 + 40); // a quiet map corner
    expect(visualInterestScore(world, ctx, main.x, main.y)).toBeGreaterThan(visualInterestScore(world, ctx, plain.x, plain.y));
  });
});
