// Vehicle handling measured on an open asphalt test track: top speeds match the specs, brakes and
// tyres are in a real car's range, and ordinary cars don't spin under a driver's usual inputs. A
// player's car grips about twice as hard and steers with yaw control (Vehicle.update), so it can take
// a junction at speed and settles the moment a key is let go.
import { describe, expect, it } from 'vitest';
import { World } from '../../src/shared/world/World';
import { Vehicle, SPECS, type VehicleKind } from '../../src/shared/entities/Vehicle';
import { NO_MODS, type Mods } from '../../src/shared/sim/shops/catalog';
import { DRAFT_SPEED, slipstream } from '../../src/shared/sim/Physics';
import { Tram, TRAM_SEG } from '../../src/shared/entities/Tram';
import type { MapJSON } from '../../src/shared/types';

const track = (() => {
  const w = new World({
    bounds: [-5000, -5000, 5000, 5000], origin: [0, 0], names: [], roads: [], trams: [], buildings: [],
    areas: { water: [], green: [], wood: [], plaza: [], parking: [], pitch: [], sand: [], rail: [] },
    rivers: [], pois: [], landmarks: [], graph: { car: { nodes: [], edges: [] }, ped: { nodes: [], edges: [] }, tram: { nodes: [], edges: [] } },
  } as MapJSON);
  w.surfaceAt = () => 'asphalt';
  return w;
})();
const dt = 1 / 120;
/** the cars (scooters and bikes handle as test/shared/bikes.test.ts checks, and boats as
 *  test/shared/danube.test.ts does) */
const kinds = (Object.keys(SPECS) as VehicleKind[]).filter((k) => !SPECS[k].twoWheeler && !SPECS[k].boat);

/** run `script` (throttle, steer, handbrake by time) from `kmh`, in traffic or (`player`) a player's
 *  car; the car and its largest body slip (deg, while going forwards) */
function run(kind: VehicleKind, kmh: number, seconds: number, script: (t: number, v: Vehicle) => [number, number, boolean?], player = false) {
  // from the west end of the 10 km track: even the Porše at full speed stays on it
  const v = new Vehicle(kind, -4900, 0, 0, '#fff');
  if (player) v.owner = 1;
  v.vx = kmh / 3.6;
  let slip = 0;
  for (let t = 0; t < seconds; t += dt) {
    const [thr, st, hb] = script(t, v);
    v.setControls(thr, st, !!hb);
    v.update(dt, track);
    if (v.speed > 5 && v.fwdSpeed > 0) {
      const d = Math.atan2(-v.vx * Math.sin(v.angle) + v.vy * Math.cos(v.angle), v.fwdSpeed);
      slip = Math.max(slip, (Math.abs(d) * 180) / Math.PI);
    }
  }
  return { v, slip };
}

describe('Vehicle', () => {
  it('reaches its top speed, and no more', () => {
    for (const k of kinds) {
      const { v } = run(k, 0, 70, () => [1, 0]);
      expect(v.speed).toBeGreaterThan(SPECS[k].maxSpeed * 0.97);
      expect(v.speed).toBeLessThan(SPECS[k].maxSpeed * 1.01);
    }
  });

  it('brakes like a car: 100 to 0 km/h in 30-45 m (a bus in under 60)', () => {
    for (const k of kinds) {
      const { v } = run(k, 100, 8, (_t, c) => [c.fwdSpeed > 0.3 ? -1 : 0, 0]);
      expect(v.x + 4900).toBeGreaterThan(30);
      expect(v.x + 4900).toBeLessThan(k === 'bus' ? 60 : 45);
    }
  });

  it('corners on its tyres: about 1 g at the limit, not the 3-6 g of a velocity that turned with the body', () => {
    for (const k of kinds) {
      const { v } = run(k, 60, 6, (_t, c) => [Math.max(0, Math.min(1, (60 / 3.6 - c.fwdSpeed) * 0.4)), 1]);
      const g = (v.speed * Math.abs(v.av)) / 9.81;
      expect(g).toBeGreaterThan(k === 'bus' ? 0.4 : 0.6);
      expect(g).toBeLessThan(1.35);
    }
  });

  it('reverses at walking-to-jogging car speeds, not 78 km/h', () => {
    for (const k of kinds) expect(-run(k, 0, 20, () => [-1, 0]).v.fwdSpeed * 3.6).toBeLessThan(32);
  });

  it('stays stable: lane changes, lifting off and braking in a bend don’t spin an ordinary car', () => {
    for (const k of kinds) {
      if (k === 'sport') continue; // a lively rear-engined car, on purpose
      expect(run(k, 100, 3, (t) => [0.3, t < 0.3 ? 1 : t < 0.6 ? -1 : 0]).slip).toBeLessThan(10);
      expect(run(k, 100, 3, (t) => [t < 0.2 ? 1 : 0, t > 0.2 && t < 1.2 ? 1 : 0]).slip).toBeLessThan(20);
      expect(run(k, 80, 3, (t) => [-1, t < 1.5 ? 1 : 0]).slip).toBeLessThan(45);
    }
  });

  it('still swings round on the handbrake, in traffic and as a player', () => {
    for (const k of ['hatch', 'sedan', 'police', 'sport'] as VehicleKind[])
      for (const player of [false, true]) {
        const { v } = run(k, 60, 1.5, (t) => [0, t < 0.8 ? 1 : 0, t < 0.8], player);
        expect((Math.abs(v.angle) * 180) / Math.PI).toBeGreaterThan(90);
      }
  });

  it("a player's car corners at about 2 g: round a city junction at 60 km/h, half traffic's circle at 90", () => {
    for (const k of kinds) {
      /** full lock holding `kmh`: the radius of the circle it settles on */
      const circle = (kmh: number, player: boolean) => {
        const { v } = run(k, kmh, 6, (_t, c) => [Math.max(0, Math.min(1, (kmh / 3.6 - c.fwdSpeed) * 0.4)), 1], player);
        return v.speed / Math.abs(v.av);
      };
      const r90 = circle(90, true);
      expect(r90, k).toBeLessThan(circle(90, false) * 0.6);
      // (a van and a bus are still a van and a bus)
      if (k === 'van' || k === 'bus') continue;
      expect(circle(60, true), k).toBeLessThan(18);
      expect(r90, k).toBeLessThan(40);
      const g = (90 / 3.6) ** 2 / r90 / 9.81;
      expect(g, k).toBeGreaterThan(1.5);
      expect(g, k).toBeLessThan(2.6);
    }
  });

  it("a player's car turns in crisply, without overshooting, and stops turning when the key is let go", () => {
    for (const k of kinds) {
      // 90 km/h: full lock (a held key) for 2 s, then let go
      const v = new Vehicle(k, -4900, 0, 0, '#fff');
      v.owner = 1;
      v.vx = 25;
      const yaw: number[] = [];
      let atRelease = 0;
      for (let t = 0; t < 3; t += dt) {
        v.setControls(Math.max(0, Math.min(1, (25 - v.fwdSpeed) * 0.4)), t < 2 ? 1 : 0);
        v.update(dt, track);
        yaw.push(v.av);
        if (t < 2) atRelease = v.angle;
      }
      const held = yaw.slice(0, 240), after = yaw.slice(240);
      const steady = held.slice(-60).reduce((a, b) => a + b) / 60;
      /** seconds until `f` first holds (Infinity: never) */
      const until = (rs: number[], f: (r: number) => boolean) => (rs.findIndex(f) + 1 || Infinity) * dt;
      // most of the way round within a quarter of a second, and not swinging past it
      expect(until(held, (r) => r > 0.9 * steady), k).toBeLessThan(0.25);
      expect(Math.max(...held) / steady, k).toBeLessThan(1.2);
      // let go: still in under half a second, a few degrees further round at most
      expect(until(after, (r) => Math.abs(r) < 0.05 * steady), k).toBeLessThan(0.45);
      expect(((v.angle - atRelease) * 180) / Math.PI, k).toBeLessThan(12);
    }
  });

  it("a player's car is as stable as traffic, the Porše included", () => {
    for (const k of kinds) {
      expect(run(k, 100, 3, (t) => [0.3, t < 0.3 ? 1 : t < 0.6 ? -1 : 0], true).slip, k).toBeLessThan(10);
      expect(run(k, 100, 3, (t) => [t < 0.2 ? 1 : 0, t > 0.2 && t < 1.2 ? 1 : 0], true).slip, k).toBeLessThan(20);
      expect(run(k, 80, 3, (t) => [-1, t < 1.5 ? 1 : 0], true).slip, k).toBeLessThan(45);
    }
  });
});

describe('Tuning (the Dielňa, docs/plans/gameplay.md Phase 2)', () => {
  const tuned = (kind: VehicleKind, m: Partial<Mods>) => {
    const v = new Vehicle(kind, -4900, 0, 0, '#fff');
    v.tune({ ...NO_MODS, ...m });
    return v;
  };
  /** seconds from standing to 72 km/h at full throttle */
  const to72 = (v: Vehicle) => {
    let t = 0;
    while (v.speed < 20 && t < 30) {
      v.setControls(1, 0, false);
      v.update(dt, track);
      t += dt;
    }
    return t;
  };

  it('the engine: quicker off the line, and a top speed 6 % and 12 % higher, no more', () => {
    for (const k of kinds) {
      const [t0, t1, t2] = [0, 1, 2].map((e) => to72(tuned(k, { engine: e })));
      expect(t1).toBeLessThan(t0 * 0.92);
      expect(t2).toBeLessThan(t1 * 0.94);
      for (const [engine, top] of [[1, 1.06], [2, 1.12]] as const) {
        const v = tuned(k, { engine });
        for (let t = 0; t < 70; t += dt) {
          v.setControls(1, 0, false);
          v.update(dt, track);
        }
        expect(v.speed, `${k} engine ${engine}`).toBeGreaterThan(SPECS[k].maxSpeed * top * 0.97);
        expect(v.speed, `${k} engine ${engine}`).toBeLessThan(SPECS[k].maxSpeed * top * 1.01);
      }
    }
  });

  it('plating: the same hit takes 25 % and 45 % less', () => {
    const hp = [0, 1, 2].map((plating) => {
      const v = tuned('sedan', { plating });
      v.damage(40);
      return v.spec.health - v.health;
    });
    expect(hp).toEqual([40, 30, 22]);
  });

  it('run-flat tyres don\'t burst', () => {
    expect(tuned('hatch', {}).burstTyres()).toBe(true);
    const v = tuned('hatch', { tyres: 1 });
    expect(v.burstTyres()).toBe(false);
    expect(v.tyresBurst).toBe(0);
  });

  it('a bigger nitro tank lasts half as long again, and twice as long', () => {
    const lasts = (nitro: number) => {
      const v = tuned('sport', { nitro });
      v.nitro = 1;
      let t = 0;
      while (v.nitro > 0 && t < 30) {
        v.setControls(1, 0, false, true);
        v.update(dt, track);
        t += dt;
      }
      return t;
    };
    const [a, b, c] = [0, 1, 2].map(lasts);
    expect(b / a).toBeCloseTo(1.5, 1);
    expect(c / a).toBeCloseTo(2, 1);
  });
});

describe('Behind the wheel (docs/plans/gameplay.md, Phase 3)', () => {
  /** full throttle for `seconds` with a fixed slipstream, from 25 m/s */
  const flatOut = (draft: number, seconds = 40) => {
    const v = new Vehicle('sedan', -4900, 0, 0, '#fff');
    v.owner = 1;
    v.vx = 25;
    for (let t = 0; t < seconds; t += dt) {
      v.draft = draft;
      v.setControls(1, 0, false);
      v.update(dt, track);
    }
    return v;
  };

  it('a slipstream raises the top speed by up to 5 % and fills the nitro faster', () => {
    const still = flatOut(0), drafting = flatOut(1);
    expect(drafting.speed / still.speed).toBeGreaterThan(1.03);
    expect(drafting.speed / still.speed).toBeLessThan(1.06);
    const fill = (draft: number) => {
      const v = new Vehicle('sedan', -4900, 0, 0, '#fff');
      v.nitro = 0;
      v.vx = 20;
      for (let t = 0; t < 2; t += dt) {
        v.draft = draft;
        v.setControls(0.5, 0, false);
        v.update(dt, track);
      }
      return v.nitro;
    };
    expect(fill(1)).toBeGreaterThan(fill(0) * 4);
  });

  it('slipstream: close behind a bus or a tram going the same way, not beside it, not coming the other way', () => {
    const me = new Vehicle('sedan', 0, 0, 0, '#fff');
    me.vx = 20;
    const bus = new Vehicle('bus', 12, 0, 0, '#fff');
    bus.vx = 18;
    expect(slipstream(me, [me, bus], [])).toBeGreaterThan(0.3);
    // further back, weaker; beside it, or a car, or coming the other way: none
    bus.x = 22;
    const far = slipstream(me, [me, bus], []);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(slipstream(me, [me, Object.assign(new Vehicle('bus', 12, 0, 0, '#fff'), { vx: 18 })], []));
    expect(slipstream(me, [me, Object.assign(new Vehicle('bus', 12, 4, 0, '#fff'), { vx: 18 })], [])).toBe(0);
    expect(slipstream(me, [me, Object.assign(new Vehicle('hatch', 8, 0, 0, '#fff'), { vx: 18 })], [])).toBe(0);
    expect(slipstream(me, [me, Object.assign(new Vehicle('bus', 12, 0, Math.PI, '#fff'), { vx: -18 })], [])).toBe(0);
    // too slow for it
    me.vx = DRAFT_SPEED - 1;
    expect(slipstream(me, [me, Object.assign(new Vehicle('bus', 12, 0, 0, '#fff'), { vx: 18 })], [])).toBe(0);
    // a tram: its last section is its tail
    me.vx = 20;
    const t = new Tram(null, null);
    t.speed = 11 * 1.5;
    t.sections = [{ x: 30, y: 0, a: 0 }, { x: 30 - TRAM_SEG - 0.6, y: 0, a: 0 }, { x: 30 - 2 * (TRAM_SEG + 0.6), y: 0, a: 0 }];
    expect(slipstream(me, [me], [t])).toBeGreaterThan(0.2);
  });

  it('a damaged side pulls the steering toward it, in a player\'s car', () => {
    const drift = (left: number, right: number) => {
      const v = new Vehicle('sedan', -4900, 0, 0, '#fff');
      v.owner = 1;
      v.vx = 15;
      v.dmg.left = left;
      v.dmg.right = right;
      for (let t = 0; t < 3; t += dt) {
        v.setControls(0.4, 0, false);
        v.update(dt, track);
      }
      return v.y;
    };
    // +y is the car's right (heading +x)
    expect(drift(0, 0)).toBeCloseTo(0, 1);
    expect(drift(1, 0)).toBeLessThan(-1);
    expect(drift(0, 1)).toBeGreaterThan(1);
  });

  it('a badly damaged engine loses power: slower off the line below 35 % health', () => {
    const to20 = (hp: number) => {
      const v = new Vehicle('hatch', -4900, 0, 0, '#fff');
      v.health = hp;
      let t = 0;
      while (v.speed < 20 && t < 30) {
        v.setControls(1, 0, false);
        v.update(dt, track);
        t += dt;
      }
      return t;
    };
    const full = to20(100), smoking = to20(30), dying = to20(2);
    expect(smoking / full).toBeGreaterThan(1.01);
    expect(dying / full).toBeGreaterThan(1.25);
    expect(dying / full).toBeLessThan(1.5);
  });
});
