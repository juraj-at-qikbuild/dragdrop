import { describe, expect, it } from 'vitest';
import { candidateSpots, SPOT_KINDS } from '../../src/shared/world/spots';
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
});
