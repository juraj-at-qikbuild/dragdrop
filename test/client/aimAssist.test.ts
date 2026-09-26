// Touch aim assist (src/game/aimAssist.ts): who the fire button locks onto.
import { describe, expect, it } from 'vitest';
import { aimKey, magnet, pickTarget, type AimCandidate, type AimOpts } from '../../src/game/aimAssist';

const gun: AimOpts = { range: 45, cone: 0.8, threatCone: 1.3, playerCone: 0.4 };
const fist: AimOpts = { range: 1.9, cone: 0.9, threatCone: 0.9, playerCone: 0.9 };
const clear = () => true;
const me = { x: 0, y: 0 };
let next = 1;
/** a candidate `d` metres away at `deg` degrees (0 = east, + clockwise) */
function at(d: number, deg: number, extra: Partial<AimCandidate> = {}): AimCandidate {
  const a = (deg * Math.PI) / 180;
  return { key: next++, x: Math.cos(a) * d, y: Math.sin(a) * d, threat: false, player: false, ...extra };
}

describe('pickTarget', () => {
  it('picks the nearest one ahead, not one behind or out of range', () => {
    const near = at(8, 10), far = at(20, 0), behind = at(3, 180), gone = at(60, 0);
    expect(pickTarget(me, 0, [far, behind, gone, near], gun, clear)).toBe(near);
    expect(pickTarget(me, 0, [behind, gone], gun, clear)).toBeNull();
  });

  it('prefers a threat, and looks for threats in a wider cone', () => {
    const civ = at(6, 0), cop = at(14, 20, { threat: true });
    expect(pickTarget(me, 0, [civ, cop], gun, clear)).toBe(cop);
    const flank = at(10, 65, { threat: true });
    expect(pickTarget(me, 0, [flank], gun, clear)).toBe(flank);
    expect(pickTarget(me, 0, [at(10, 65)], gun, clear)).toBeNull();
  });

  it('only helps against other players in a narrow cone, with no threat bonus', () => {
    const player = at(10, 30, { player: true, threat: true });
    expect(pickTarget(me, 0, [player], gun, clear)).toBeNull();
    const ahead = at(10, 15, { player: true, threat: true }), civ = at(9, 5);
    expect(pickTarget(me, 0, [ahead, civ], gun, clear)).toBe(civ);
  });

  it('skips targets behind walls', () => {
    const hidden = at(5, 0), seen = at(12, 5);
    expect(pickTarget(me, 0, [hidden, seen], gun, (x) => x > 6)).toBe(seen);
  });

  it('keeps its lock on a target over a similar newcomer', () => {
    const a = at(10, 4), b = at(9.5, 3);
    expect(pickTarget(me, 0, [a, b], gun, clear)).toBe(b);
    expect(pickTarget(me, 0, [a, b], gun, clear, a.key)).toBe(a);
  });

  it('with the fist, only reaches who is within 0.9 rad of the facing', () => {
    const side = at(1.5, 60), front = at(1.6, 40);
    expect(pickTarget(me, 0, [side], fist, clear)).toBeNull();
    expect(pickTarget(me, 0, [front], fist, clear)).toBe(front);
  });

  it('can look all around (drive-bys)', () => {
    const back = at(12, 170, { threat: true });
    expect(pickTarget(me, 0, [back], { ...gun, cone: Math.PI, threatCone: Math.PI }, clear)).toBe(back);
  });

  it('keeps peds and cars apart', () => {
    expect(aimKey(5, false)).not.toBe(aimKey(5, true));
  });
});

describe('magnet', () => {
  it('pulls a hand-aimed drag onto a target just off it, and leaves it alone otherwise', () => {
    const t = at(15, 8);
    const pulled = magnet(me, 0, [t], 45, clear);
    expect(pulled.target).toBe(t);
    expect(pulled.angle).toBeCloseTo((8 * Math.PI) / 180, 5);
    const free = magnet(me, 0, [at(15, 30)], 45, clear);
    expect(free.target).toBeNull();
    expect(free.angle).toBe(0);
  });
});
