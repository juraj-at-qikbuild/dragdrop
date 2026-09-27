// What the police can see (src/shared/sim/sight.ts; docs/plans/gameplay.md, Phase 1): cones, ranges,
// darkness through the day, rain, and the helicopter's view by day and by its beam at night.
import { describe, expect, it } from 'vitest';
import { BEAM_DARK, DARK_CAR, HELI_BEAM_R, HELI_DAY_R, SIGHT, heliSees, inSight, sightEnv } from '../../src/shared/sim/sight';
import { darkness } from '../../src/shared/sim/Clock';

describe('darkness', () => {
  it('is 0 by day, 1 in the middle of the night, and in between at dusk and dawn', () => {
    expect(darkness(12)).toBe(0);
    expect(darkness(15)).toBe(0);
    expect(darkness(2)).toBeGreaterThan(0.99);
    expect(darkness(23)).toBeGreaterThan(0.9);
    const dusk = darkness(20.3), dawn = darkness(6);
    for (const d of [dusk, dawn]) {
      expect(d).toBeGreaterThan(0.2);
      expect(d).toBeLessThan(0.9);
    }
    expect(darkness(26)).toBe(darkness(2)); // wraps round the day
  });
});

describe('sightEnv', () => {
  it('sees furthest at noon in dry weather, least at night in the rain', () => {
    expect(sightEnv(12, 0)).toEqual({ dark: 0, scale: 1 });
    expect(sightEnv(2, 0).scale).toBeCloseTo(0.6, 2);
    expect(sightEnv(12, 1).scale).toBeCloseTo(0.8);
    expect(sightEnv(2, 1).scale).toBeCloseTo(0.48, 2);
  });
});

describe('inSight', () => {
  const car = SIGHT.car;
  // a unit at the origin facing east (+x)
  const see = (x: number, y: number, scale = 1, target = 1) => inSight(0, 0, 0, car, scale, x, y, target);

  it('sees ahead within the cone and the range, and says how far', () => {
    expect(see(40, 0)).toBeCloseTo(40);
    expect(see(69, 0)).toBeCloseTo(69);
    expect(see(71, 0)).toBe(-1);
    // 55° off to the side is inside a ±60° cone, 65° isn't
    const at = (deg: number, d: number) => see(Math.cos((deg * Math.PI) / 180) * d, Math.sin((deg * Math.PI) / 180) * d);
    expect(at(55, 40)).toBeGreaterThan(0);
    expect(at(65, 40)).toBe(-1);
    expect(at(-55, 40)).toBeGreaterThan(0);
  });

  it('never sees behind beyond its close range, and always sees within it', () => {
    expect(see(-40, 0)).toBe(-1);
    expect(see(-13, 0)).toBeCloseTo(13);
    expect(see(0, 13)).toBeCloseTo(13);
  });

  it('sees less far by night, in rain, and a dark still car less far still, but never less up close', () => {
    const night = sightEnv(2, 0).scale;
    expect(see(55, 0)).toBeGreaterThan(0);
    expect(see(55, 0, night)).toBe(-1);
    expect(see(40, 0, night)).toBeGreaterThan(0);
    expect(see(40, 0, night, DARK_CAR)).toBe(-1);
    expect(see(13, 0, night, DARK_CAR)).toBeCloseTo(13);
  });

  it('gives a cop on foot a shorter, wider look than a car', () => {
    const foot = SIGHT.foot;
    expect(inSight(0, 0, 0, foot, 1, 39, 0)).toBeGreaterThan(0);
    expect(inSight(0, 0, 0, foot, 1, 45, 0)).toBe(-1);
    const a = (65 * Math.PI) / 180;
    expect(inSight(0, 0, 0, foot, 1, Math.cos(a) * 30, Math.sin(a) * 30)).toBeGreaterThan(0);
    expect(inSight(0, 0, 0, foot, 1, -9, 0)).toBe(-1);
    expect(inSight(0, 0, 0, foot, 1, -7, 0)).toBeCloseTo(7);
  });
});

describe('the helicopter', () => {
  const h = { x: 0, y: 0, tx: 40, ty: 0 };

  it('by day sees the circle under it, wherever its beam points', () => {
    expect(heliSees(h, 0, HELI_DAY_R - 1, 0)).toBe(true);
    expect(heliSees(h, 0, 0, HELI_DAY_R + 1)).toBe(false);
    expect(heliSees(h, 0, 40, 0)).toBe(false);
  });

  it('after dark sees only what its beam lights', () => {
    expect(heliSees(h, BEAM_DARK, 40 + HELI_BEAM_R - 1, 0)).toBe(true);
    expect(heliSees(h, 1, 0, 0)).toBe(false); // right under it, but in the dark
    expect(heliSees(h, 1, 40, HELI_BEAM_R + 1)).toBe(false);
  });
});
